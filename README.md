# LocalBlock

A small, auditable ad blocker for Chrome. Everything runs on your machine. The extension makes no network requests of its own and collects nothing.

## How it works

- **Network blocking.** The `rules/*.json` files are Chrome `declarativeNetRequest` rulesets. Chrome itself matches every request against them, so blocking happens inside the browser, with no extension code inspecting your traffic.
- **Filter lists.** Besides LocalBlock's own short list (`rules/domains.txt`), the extension ships [EasyList](https://easylist.to/) (ads) and EasyPrivacy (trackers), compiled into rulesets at build time. Updating them is a build step; the extension never downloads anything.
- **Pausing.** Pausing on a site adds a local "allow everything" rule for that site. Pausing everywhere turns all rulesets off.
- **Permissions.** `declarativeNetRequest`, `storage` (to remember the global pause) and `activeTab` (to read the current tab's site and blocked count when you open the popup). No host permissions.

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Pin LocalBlock to the toolbar. The badge shows how many requests were blocked on the current tab.

## Updating the filter lists

Requires Node.js 20 or later; there are no dependencies to install.

```sh
npm run update   # download EasyList + EasyPrivacy and rebuild rules/*.json
npm test         # run the converter tests
```

Then click the reload icon for LocalBlock on `chrome://extensions`.

`tools/fetch-lists.mjs` assembles the lists from their sources in [easylist/easylist](https://github.com/easylist/easylist). `tools/abp2dnr.mjs` converts each filter to a Chrome rule. Filters Chrome cannot express faithfully (regex filters, `$popup`, `$csp`, `$redirect` and similar) are skipped rather than approximated, so a converted rule never blocks more than the list intended. The build prints what was skipped and why. Cosmetic (`##`) filters are extracted for the upcoming cosmetic-filtering feature.

To change LocalBlock's own list, edit `rules/domains.txt` and run `npm run build`.

## Roadmap

- [x] Network blocking of core ad domains, per-site and global pause, blocked count
- [x] Compile EasyList and EasyPrivacy into rulesets
- [ ] Cosmetic filtering (hide leftover ad boxes)
- [ ] Scriptlets for sites like YouTube
- [ ] "Hide something on this page" element picker
- [ ] Options page: choose lists, manage paused sites

## License

LocalBlock is licensed under the [GNU General Public License v3.0 or later](LICENSE).

The bundled rulesets are derived from EasyList and EasyPrivacy, © The EasyList authors, used under GPL-3.0 (see [easylist.to/pages/licence.html](https://easylist.to/pages/licence.html)).
