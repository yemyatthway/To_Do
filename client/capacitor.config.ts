import type { CapacitorConfig } from '@capacitor/cli'

/** The iPhone app: the same React app, built into `dist` and wrapped in a native shell. */
const config: CapacitorConfig = {
  appId: 'app.todoclock',
  appName: 'Todo Clock',
  webDir: 'dist',
  ios: {
    // The page already lays itself out around the notch and home bar (viewport-fit=cover).
    contentInset: 'never',
    backgroundColor: '#e6eef8',
  },
  plugins: {
    LocalNotifications: {
      // Reminders show as a banner even while the app is open.
      presentationOptions: ['banner', 'sound', 'list'],
    },
  },
}

export default config
