# Lead লও

Lead লও is a Chrome extension for collecting qualified business leads from Google Maps and exporting them to CSV.

It is designed for local, browser-based research workflows: no Google Maps API key, no Google Sheets API, and no OAuth setup required.

## Features

- Search Google Maps by keyword and location.
- Segment broad Bangladesh and Dhaka searches into smaller regions.
- Collect business name, phone, website, email, address, rating, reviews, category, and Maps URL.
- Filter lead quality with `Any selected` or `All selected` rules.
- Skip weak/non-business results such as localities, roads, buildings, and generic places.
- Deduplicate by phone, email, website, and Maps place identity.
- Pause, resume, stop, and export partial results safely.
- Download CSV automatically when the run completes.
- Floating progress panel inside Google Maps.
- Dark premium UI using the Lead লও brand colors.

## Installation

Chrome cannot install the GitHub source ZIP by dragging it into `chrome://extensions`.

Use this flow instead:

1. Download or clone this repository.
2. If you downloaded a ZIP from GitHub, extract/unzip it first.
3. Open Chrome and go to `chrome://extensions`.
4. Enable **Developer mode**.
5. Click **Load unpacked**.
6. Select the extracted folder that contains `manifest.json`.
7. Pin **Lead লও** from the Chrome extensions toolbar.

Do not select the `.zip` file itself. Chrome's **Load unpacked** needs a folder, not an archive.

## Usage

1. Open the extension popup.
2. Enter a keyword, for example `Restaurant`, `Real Estate`, or `Dentist`.
3. Enter a location, for example `Dhaka`, `Gulshan Dhaka`, or `Bangladesh`.
4. Set the lead limit.
5. Choose lead quality:
   - **Any selected** accepts a lead when at least one selected info field exists.
   - **All selected** accepts a lead only when every selected info field exists.
6. Optionally choose CSV columns from the advanced section.
7. Click **Start scraping**.
8. Keep Chrome open while the extension works through Google Maps.

## Lead Quality Rules

Lead লও can require one or more fields before saving a lead.

Examples:

- Select `Phone` with `Any selected` to accept leads that have a phone number.
- Select `Phone` and `Website` with `All selected` to accept only leads that have both.
- Select `Email` and `Website` with `Any selected` to accept leads that have either email or website.

Required fields are automatically included in the CSV export columns.

## CSV Output

CSV files are downloaded as:

```text
lead-low-<timestamp>.csv
```

The export includes a UTF-8 BOM and `sep=,` marker for better Excel compatibility.

## Data Fields

| Label | Key |
| --- | --- |
| Business Name | `name` |
| Phone Number | `phone` |
| Website | `website` |
| Email | `email` |
| Address | `address` |
| Rating | `rating` |
| Reviews | `reviews` |
| Category | `category` |
| Google Maps URL | `mapsUrl` |

## Project Structure

```text
leadharvest/
  background/
    background.js
    bd-search-segments.js
  content/
    maps-content.js
    floating-window.css
  icons/
    icon16.png
    icon48.png
    icon128.png
  popup/
    popup.html
    popup.css
    popup.js
  logo.png
  manifest.json
```

## Development

No build step is required. Edit the files directly and reload the extension from `chrome://extensions`.

Basic syntax check:

```bash
node --check background/background.js
node --check content/maps-content.js
node --check popup/popup.js
```

## Limitations

- Google Maps DOM can change and may require selector updates.
- Scraping may be slowed or blocked by Google anti-abuse systems.
- Email availability is limited because Google Maps rarely exposes emails directly.
- Large runs may take time and require Chrome to stay open.

## Responsible Use

Use Lead লও responsibly and lawfully.

- Respect website terms and local data protection laws.
- Do not use harvested data for spam, harassment, or illegal activity.
- Keep outreach compliant with the rules that apply in your region.

## License

MIT
