# Pocket

Your localhost, pocket-sized: a phone-sized window on your Mac that behaves like a phone, keyboard, in-app browsers, slow networks and all, and that Claude, Cursor or any other MCP agent can drive for you.

Chrome's device mode gets a phone's size right, but not the things that make phones hard: the keyboard taking half the screen, a link opened inside Instagram, a budget Android on 3G. Pocket does those, and lets your coding agent check them while you watch.

## Let your agent drive it

```
npm run connect
```

This adds Pocket to the MCP servers of the Claude app and Cursor (whichever you have) and leaves everything else in their settings alone. Restart them, and your agent gets four tools:

- **scene** picks the phone, the app the page is opened in, a persona, the network, the phone's speed, the keyboard and landscape.
- **look** returns a screenshot, keyboard included, plus a list of what's on screen with tap points, and what the keyboard is hiding.
- **act** opens, taps, types, presses, scrolls, goes back and reloads like a person would, then reports what that set off.
- **activity** lists the Mixpanel events (with their properties), errors and failed requests since the last check.

Everything happens in the Pocket window, so you can watch it work. The agent can't tap through the keyboard: if a button is hidden behind it, the agent is told so, just as a person would find out. Something to ask it:

> Open /signup in Pocket as the Lagos persona, fill in the form, and tell me which Mixpanel events fire and whether the keyboard ever hides the submit button.

Any other MCP client can run Pocket's server with this:

```json
"pocket": {
  "command": "/Applications/Pocket.app/Contents/MacOS/Pocket",
  "args": ["/Applications/Pocket.app/Contents/Resources/app.asar/mcp.js"],
  "env": { "ELECTRON_RUN_AS_NODE": "1" }
}
```

It needs nothing else installed, because Pocket's own binary runs it. If Pocket isn't open, the first tool call opens it.

## Install

You need a Mac and Node.js 22.12 or newer. Clone this repo, then:

```
npm install
npm run build
npm link
```

`npm run build` makes Pocket.app and puts it in Applications. It signs the app for your own Mac only (no Apple developer account needed), which is why there's no download: macOS blocks an app signed like that when it comes from somewhere else. `npm link` is optional and gives you the `pocket` command.

## Use

```
pocket             http://localhost:3000
pocket 5173        http://localhost:5173
pocket /map        http://localhost:3000/map
pocket <url>       anything else
```

Running `pocket` again while it's open brings the window back, and `pocket 5173` points it somewhere new. If your dev server is down, Pocket waits and loads the page by itself once it's back. It remembers the phone, your settings and where you left the window.

- **Device:** iPhone SE 375×667, iPhone 393×852, iPhone Pro 402×874, iPhone Pro Max 440×956, Small Android 360×800 (a Samsung Galaxy A15), Pixel 412×915 and iPad mini 744×1133, with each one's screen density, touch and user agent. The window shrinks to fit your screen when a phone is taller than it, but the page still gets the phone's full size. ⌘1 to ⌘7, and ⌘L for landscape.
- **Open In:** the phone's own browser (Safari or Chrome), or the in-app browser of Instagram or Facebook, which is where people land when they tap a link or an ad there: the app's identity, a cookie jar of its own, and every link kept inside. ⌥⌘1 to ⌥⌘3.
- **Persona:** one click sets the whole scene. London (iPhone in Safari, fast 4G), New York (iPhone Pro from an Instagram ad, fast 4G), Lagos (small Android from an Instagram ad, slow 4G, budget phone) and Mumbai (small Android from a Facebook ad, 3G, budget phone), each with its own language, time zone and location. Just Me goes back to your own place and normal conditions, on the same phone.
- **Speed:** Chrome DevTools' network presets (Fast 4G, Slow 4G, 3G, Offline), and a phone that runs scripts 4× or 6× slower than your Mac.
- **Keyboard:** tap into a field and the phone's own keyboard comes up, at its real size: Apple's on iPhones and the iPad, Samsung's on the small Android, Gboard on the Pixel, or whichever you pick, or none at all. It matches the field (number pad, phone pad, @ for email) and shows the return key the page asks for, such as Go, Search or Send. Safari and Chrome cover the page and slide the field into view; on Android, the in-app browsers, and pages that ask for it with `interactive-widget=resizes-content`, shrink the page instead. You type on your Mac and the keys light up.
- **Activity panel** (⌘E): Mixpanel events as they're sent, straight to Mixpanel or through your own proxy, plus console errors and failed requests. The error count also shows in the title bar and on the Dock icon.
- **Copy Screenshot** (⇧⌘C) at the phone's full resolution, keyboard included.
- **Clear Cookies and Storage** (⇧⌘⌫) signs you out and starts fresh, like a first-time visitor from an ad, for the current browser only.
- Back ⌘[, Forward ⌘], Reload ⌘R, Hard Reload ⇧⌘R, Float on Top ⇧⌘F (on by default), DevTools ⌥⌘I.

## What it isn't

Pocket is Chromium dressed as a phone. The size, touch, user agent, keyboard space, network and speed are emulated, but the engine is Chrome's, so a bug that only Safari has won't show up here: check those on a real iPhone. The in-app browsers are those apps' identities and cookie jars, not the apps themselves. Pocket.app is built on a Mac; elsewhere, `npm start` runs it from source.

## How it works

Pocket is an Electron app that drives its page through the Chrome DevTools Protocol, the same machinery as DevTools' device mode: device size, touch, user agent and client hints, locale, time zone, location, and network and CPU throttling. The keyboard is a layer drawn over the page. A small script in the page tells Pocket when a field gets focus and adjusts what `visualViewport` reports, so code that fits itself around the keyboard behaves as it would on a phone. Agents reach the app through `mcp.js`, an MCP server with no dependencies, over a socket that only your user account can open.

## License

MIT
