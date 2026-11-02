# Shorts Block

A minimal Manifest V3 Chrome extension for schools. Every YouTube Short is replaced with a plain block screen, the comments and description panels are hidden, the surrounding recommended Shorts are hidden, and scrolling or arrowing to the next Short is disabled. The rest of YouTube is untouched.

It is three small files, needs no permissions, has no background worker, no options page and no network access, and does nothing until a Shorts page is actually open. That keeps it cheap enough for low-end Chromebooks.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Declares one content script for `https://www.youtube.com/*` and `https://m.youtube.com/*`. |
| `content.js` | Decides when the block applies, keeps the video paused, swallows scroll and navigation keys. |
| `block.css` | Hides the player, overlay, panels and arrows, and draws the block screen with pseudo-elements. |

## How it works

YouTube is a single-page app, so the URL changes without a page load. The content script runs at `document_start` and listens for YouTube's own navigation events: `yt-navigate-start` and `yt-navigate-finish` on the desktop site, `state-change` and `state-navigateend` on the mobile site, with a one-attribute observer on the mobile `<body>` class as a safety net. When the page is a Short it adds `class="ytsb-blocked"` to `<html>`; otherwise it removes it. Everything visual is a CSS rule under that class, so toggling one class is the whole cost of blocking or unblocking.

- **Block screen:** the player box (`#player-container` on desktop, `<shorts-video>` on mobile) keeps its size while its children are hidden, so the block icon and message are drawn on it with `::before` and `::after`. No DOM is inserted and nothing in the page tree is observed.
- **Sound:** CSS cannot stop audio. A single capture-phase `play` listener on `document` pauses any media element that starts while a Short is blocked. YouTube reuses one player across Shorts, so this covers every Short the student lands on.
- **Scrolling:** YouTube moves between Shorts on wheel, touch and the arrow and page keys. Capture-phase listeners on `window` stop those events before YouTube sees them. They are attached only while a Short is blocked, because a non-passive wheel listener forces every scroll on the site through the main thread. Keys are ignored when the focus is in a text field, so the search box still works.
- **Comments and recommendations:** the side panels (`#shorts-panel-container`), the overlay with title, channel, like and comment buttons, the previous and next arrows and the thumbnails of neighbouring Shorts are hidden. On mobile the same goes for the comments bottom sheet and the poster frames on the neighbouring carousel slides.

Students can still leave the page through the sidebar, the search box or the browser's back button; the aim is to make Shorts useless, not to trap the tab.

## Installing

For a quick trial, open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and select this folder.

For a managed fleet, deploy it through Google Admin (Devices, Chrome, Apps and extensions, Users and browsers) as a force-installed extension. Google Admin needs either a Chrome Web Store listing or a self-hosted packed `.crx` with an update URL. Publishing to the Web Store requires a 128 px icon and a short privacy declaration; this extension collects nothing, so the declaration is simple. Students on managed devices cannot disable a force-installed extension.

## Limitations

- Both `www.youtube.com` and `m.youtube.com` are covered. Other hosts such as `youtube-nocookie.com` embeds are not.
- Shorts embedded on other sites and the Shorts shelf on the home page are untouched; the home shelf is a few more CSS rules if wanted.
- YouTube changes its markup from time to time. The selectors in `block.css` were checked against the live site on 2 November 2026; if a change slips through, the video is still paused by `content.js`, but the block screen or an overlay element may need a selector update.

## Checking it works

Open any Short on either site. You should see a dark panel with a red block icon and the message, no video, no comments, no arrows, and the mouse wheel, swipes and arrow keys should do nothing. Open the Home page or a normal video: everything should behave as usual. The checks run during development are recorded in `.agent/STATE.md`.
