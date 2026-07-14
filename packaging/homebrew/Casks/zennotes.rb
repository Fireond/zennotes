cask "zennotes" do
  arch arm: "arm64", intel: "x64"

  version "2.13.2"
  sha256 arm:   "62773ec983b831e8666c1368357b1973982ea3a6599669e265892ae568e142ab",
         intel: "016017cd0bda1b37e940818818b10c923fd49950b093b5fd564d0a00950bbb19"

  url "https://github.com/ZenNotes/zennotes/releases/download/v#{version}/ZenNotes-#{version}-mac-#{arch}.dmg"
  name "ZenNotes"
  desc "Keyboard-first, local-first Markdown notes with vim motions and live preview"
  homepage "https://github.com/ZenNotes/zennotes"

  livecheck do
    url :url
    strategy :github_latest
  end

  # The app ships its own electron auto-updater, so let it update in place
  # rather than having Homebrew flag it as outdated on every release.
  auto_updates true
  depends_on macos: :monterey

  app "ZenNotes.app"

  zap trash: [
    "~/Library/Application Support/ZenNotes",
    "~/Library/Caches/com.adibhanna.zennotes",
    "~/Library/Caches/com.adibhanna.zennotes.ShipIt",
    "~/Library/HTTPStorages/com.adibhanna.zennotes",
    "~/Library/Logs/ZenNotes",
    "~/Library/Preferences/com.adibhanna.zennotes.plist",
    "~/Library/Saved Application State/com.adibhanna.zennotes.savedState",
  ]
end
