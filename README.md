# LocalBlock

A small, auditable ad blocker for Chrome. Everything runs on your machine. The extension makes no network requests of its own and collects nothing.

## How it works

- **Network blocking.** `rules/base.json` is a Chrome `declarativeNetRequest` ruleset. Chrome itself matches every request against it, so blocking happens inside the browser, with no background script inspecting your traffic.
- **Third-party only.** A rule blocks a domain only when another site loads it, so visiting that domain directly still works.
- **Pausing.** Pausing on a site adds a local "allow everything" rule for that site. Pausing everywhere turns the ruleset off.
- **Permissions.** `declarativeNetRequest`, `storage` (to remember the global pause) and `activeTab` (to read the current tab's site and blocked count when you open the popup). No host permissions.

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Pin LocalBlock to the toolbar. The badge shows how many requests were blocked on the current tab.

## Editing the block list

Edit `rules/domains.txt` (one domain per line), then run:

```sh
node tools/build-rules.mjs
```

and click the reload icon for LocalBlock on `chrome://extensions`.

## Roadmap

- [x] Network blocking of core ad domains, per-site and global pause, blocked count
- [ ] Compile community filter lists (EasyList, EasyPrivacy) into rulesets
- [ ] Cosmetic filtering (hide leftover ad boxes)
- [ ] Scriptlets for sites like YouTube
- [ ] "Hide something on this page" element picker
- [ ] Options page and filter-list updates

## License

To be decided before reusing community filter lists or scriptlets; GPL-3.0 keeps the most options open.
