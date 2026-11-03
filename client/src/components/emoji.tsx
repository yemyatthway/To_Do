/** Popular emoji for one tap, mostly for computers. Phones have every emoji on their own keyboard. */
const GROUPS: { name: string; emoji: string }[] = [
  { name: 'Smileys', emoji: '😀 😃 😄 😁 😆 😅 😂 🤣 🥲 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥸 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 ☹️ 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🫡 🤭 🫢 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 😈 👿 💀 👻 👽 🤖 💩 🤡' },
  { name: 'Hands', emoji: '👍 👎 👏 🙌 🫶 🤝 🙏 👋 🤚 ✋ 🖐️ 👌 🤌 🤏 ✌️ 🤞 🫰 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✊ 👊 🤛 🤜 💪 ✍️ 👀 🧠' },
  { name: 'Hearts', emoji: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❤️‍🔥 💕 💞 💓 💗 💖 💘 💝' },
  { name: 'Animals and nature', emoji: '🐶 🐱 🐭 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦋 🐝 🐢 🐍 🐙 🐟 🐬 🐳 🌸 🌹 🌻 🌷 🌱 🌲 🍀 🍁 🌈 ☀️ 🌙 ⭐ 🌟 ⚡ 🔥 💧 🌊 ❄️ ☁️ 🌍' },
  { name: 'Food', emoji: '🍎 🍊 🍋 🍌 🍉 🍇 🍓 🍑 🥭 🥑 🌽 🌶️ 🍞 🧀 🍔 🍟 🍕 🌭 🌮 🍜 🍝 🍣 🍱 🍛 🍚 🍰 🎂 🍩 🍪 🍫 🍦 ☕ 🍵 🧋 🥤 🍺 🍷' },
  { name: 'Activities and places', emoji: '⚽ 🏀 🏈 🎾 🏸 🏓 🏃 🚴 🏋️ 🧘 🎉 🎊 🎈 🎁 🏆 🥇 🎮 🎯 🎲 🎵 🎶 🎧 🎤 🎬 📸 🎨 🚗 🚌 🚆 ✈️ 🚀 🏠 🏢 🏝️ ⛰️' },
  { name: 'Things and signs', emoji: '💻 📱 ⌚ 💡 🔋 📅 ⏰ ⏳ 📌 📎 📝 📚 ✏️ 📧 💰 💳 🔑 🔒 🛠️ ⚙️ 🧹 🛒 ✅ ❌ ❗ ❓ ⚠️ 🚫 💯 ✨ 💥 💤 💬 ➕ 🆗 🆕' },
]

interface EmojiGridProps {
  selected?: string | null
  onPick: (emoji: string) => void
}

export function EmojiGrid({ selected, onPick }: EmojiGridProps) {
  return (
    <div className="emoji-groups">
      {GROUPS.map((group) => (
        <section key={group.name} aria-label={group.name}>
          <h3 className="emoji-group-name">{group.name}</h3>
          <div className="emoji-grid">
            {group.emoji.split(' ').map((emoji) => (
              <button key={emoji} type="button" className="emoji-key" aria-pressed={selected === emoji} onClick={() => onPick(emoji)}>
                {emoji}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
