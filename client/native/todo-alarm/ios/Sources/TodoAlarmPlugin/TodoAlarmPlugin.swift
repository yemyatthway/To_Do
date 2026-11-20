import Foundation
import UIKit
import Capacitor
#if canImport(AlarmKit)
import AlarmKit
import SwiftUI
#endif

/// Task reminders that ring like the Clock app: full screen, through silent mode and Focus, until
/// stopped. Uses AlarmKit, so only on iOS 26 and later; older iPhones keep normal notifications.
@objc(TodoAlarmPlugin)
public class TodoAlarmPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TodoAlarmPlugin"
    public let jsName = "TodoAlarm"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sync", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise)
    ]

    /// Todo Clock's page in the Settings app, where alarms can be allowed after saying no once.
    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url)
            }
            call.resolve()
        }
    }

    /// {available, permission: "authorized" | "denied" | "notDetermined"}
    @objc func status(_ call: CAPPluginCall) {
        #if canImport(AlarmKit)
        if #available(iOS 26.0, *) {
            call.resolve(["available": true, "permission": Self.name(AlarmManager.shared.authorizationState)])
            return
        }
        #endif
        call.resolve(["available": false, "permission": "denied"])
    }

    @objc func requestPermission(_ call: CAPPluginCall) {
        #if canImport(AlarmKit)
        if #available(iOS 26.0, *) {
            Task {
                do {
                    let state = try await AlarmManager.shared.requestAuthorization()
                    call.resolve(["permission": Self.name(state)])
                } catch {
                    call.reject(error.localizedDescription)
                }
            }
            return
        }
        #endif
        call.resolve(["permission": "denied"])
    }

    /// Replaces every alarm this app has waiting with the given ones: [{title, at (ms since 1970)}].
    /// An alarm that's ringing right now is left alone.
    @objc func sync(_ call: CAPPluginCall) {
        #if canImport(AlarmKit)
        if #available(iOS 26.0, *) {
            let wanted: [(String, Date)] = (call.getArray("alarms", JSObject.self) ?? []).compactMap { item in
                guard let title = item["title"] as? String, let at = item["at"] as? Double else { return nil }
                return (title, Date(timeIntervalSince1970: at / 1000))
            }
            Task {
                let manager = AlarmManager.shared
                for alarm in (try? manager.alarms) ?? [] where alarm.state == .scheduled {
                    try? manager.cancel(id: alarm.id)
                }
                var scheduled = 0
                for (title, date) in wanted where date > Date() {
                    do {
                        try await Self.schedule(title: title, at: date)
                        scheduled += 1
                    } catch {
                        break // most likely iOS's limit on waiting alarms: the soonest ones are already set
                    }
                }
                call.resolve(["scheduled": scheduled])
            }
            return
        }
        #endif
        call.resolve(["scheduled": 0])
    }

    #if canImport(AlarmKit)
    @available(iOS 26.0, *)
    private static func schedule(title: String, at date: Date) async throws {
        let text = LocalizedStringResource(String.LocalizationValue(title))
        let alert: AlarmPresentation.Alert
        if #available(iOS 26.1, *) {
            alert = AlarmPresentation.Alert(title: text) // iOS adds its own Stop button
        } else {
            alert = AlarmPresentation.Alert(title: text, stopButton: AlarmButton(text: "Stop", textColor: .white, systemImageName: "stop.circle"))
        }
        let attributes = AlarmAttributes<TodoAlarmMetadata>(
            presentation: AlarmPresentation(alert: alert),
            metadata: TodoAlarmMetadata(),
            tintColor: Color(red: 0.18, green: 0.44, blue: 0.84)
        )
        _ = try await AlarmManager.shared.schedule(id: UUID(), configuration: .alarm(schedule: .fixed(date), attributes: attributes))
    }

    @available(iOS 26.0, *)
    private static func name(_ state: AlarmManager.AuthorizationState) -> String {
        switch state {
        case .authorized: return "authorized"
        case .denied: return "denied"
        default: return "notDetermined"
        }
    }
    #endif
}

#if canImport(AlarmKit)
@available(iOS 26.0, *)
struct TodoAlarmMetadata: AlarmMetadata {}
#endif
