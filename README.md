# ibom-scanner

Adds a camera / barcode **part scanner** to any [InteractiveHtmlBom](https://github.com/openscopeproject/InteractiveHtmlBom) (iBOM) page.

Hold a component bag in front of your webcam. The scanner reads the label, finds the part in the BOM, highlights where it goes on the board, shows how many you need versus how many are in the bag, and ticks it off.

Made for kitting and hand assembly: check that every part is there before assembly day, then find any bag's place on the board in one second.

## What it does

- Reads the **2D Data Matrix** on Mouser and Digi-Key labels (ECIA / ANSI MH10.8.2 format): manufacturer part number + quantity.
- Reads plain **P/N barcodes** (Code 128) and QR codes on other suppliers' labels (e.g. Ovaga), but only when they match a part in the BOM. PO, invoice and website codes on the same label are ignored.
- Works with a **USB 2D barcode scanner** too, or by typing a part number.
- Shows **need vs bag quantity**, the refs split into **Top / Bottom**, and the iBOM row number.
- Ticks the iBOM's own **Sourced** checkbox, so progress shows in the table and is included in iBOM's settings Export / Import.
- **Show unchecked lines** lists what's still missing. Click a line to show it on the board, double-click to tick it by hand.
- Handles packing and ordering suffixes: `74AHC1G09GV,125`, `TPS259472ARPWR`, Mouser's `595-...` prefix. Close-but-not-exact matches show in yellow with a confirm button.
- Optional **top-only / bottom-only** pages for two-pass reflow. They keep the full-board row numbers, and a bag for the other side gets a "Not on this side" warning.
- Everything runs locally in the page. The decoder (zxing-cpp, WebAssembly) is embedded, so it works offline and nothing is uploaded.

## Requirements

- Python 3.7+ (standard library only, nothing to install)
- An iBOM made with InteractiveHtmlBom **v2.4 or newer** that includes a **manufacturer part number field**
- Chrome or Edge to use it (camera access)

### Getting the part number into your iBOM

The scanner matches against a part-number field in the iBOM. When generating the iBOM, add your MPN field:

- KiCad plugin dialog: **Fields** tab, tick your MPN field (e.g. `MPN`, `PartNumber`, `Manufacturer Part Number`)
- Command line: `generate_interactive_bom board.kicad_pcb --extra-fields MPN`

Common field names are detected automatically. Otherwise use `--mpn-field`.

## Usage

```sh
git clone <this repo>
cd ibom-scanner

python ibom_scanner.py path/to/ibom.html
# -> path/to/ibom_scanner.html
```

Open the new file in Chrome, click **Start camera**, and hold a label 10 to 20 cm from the camera.

### Options

| Option | What it does |
|---|---|
| `-o FILE` | Output file name |
| `--in-place` | Overwrite the input file |
| `--side top` / `--side bottom` | Only list one side's parts (writes `ibom_top.html` / `ibom_bottom.html`) |
| `--mpn-field NAME` | Field with the manufacturer part number (if auto-detect picks the wrong one) |
| `--mfr-field NAME` | Field with the manufacturer name (optional) |
| `--checkbox NAME` | iBOM checkbox column to tick (default `Sourced`) |
| `--extras FILE.csv` | Replacement part numbers and notes, see below |

Running the tool again on an already patched file replaces the old scanner instead of adding a second one.

### Extras CSV (optional)

If you ordered a replacement for some parts, list it so the scanner accepts that bag:

```csv
mpn,alternates,note
GRM21BR61A226ME44L,GRM219R61A226MEA0D,swapped: original out of stock
AISC-0402-5N6G-T,744765056A,
TMP421AIDCNR,TMP421AQDCNRQ1;TMP421AIDCNT,
```

- `mpn`: the part number as it is in the iBOM
- `alternates`: other part numbers that count as the same part, separated by `;`
- `note`: shown under the part when it's scanned

See `examples/extras.csv`.

## Tips

- Turn off camera background blur (Windows Studio Effects, Teams, etc.) or labels get blurred too.
- Hold the bag flat and tilt it until there's no glare across the code. The square code should fill a good part of the preview.
- If the browser blocks the camera on a local file, serve the folder: `python -m http.server`, then open `http://localhost:8000/ibom_scanner.html`.
- Ticks are stored in the browser (per board name), not in the file. Use the iBOM gear menu, **Export**, to back them up or move them to another computer.
- Don't keep two pages of the same board open at once; each tab saves its own copy of the ticks.

## How it works

`ibom_scanner.py` appends one block to the end of the iBOM page: the decoder, the scanner script and its styles, and a small config (which field is the MPN, which side, extras). The scanner builds its part list from the iBOM's own data at load time and uses iBOM's filter, highlight and checkbox functions. Nothing else in the iBOM is changed, except in `--side` mode, where one line is patched so the table keeps the full-board row numbers.

Source: `src/scanner.js`, `src/scanner.css`. Decoder: `vendor/zxing-wasm/`.

## License

MIT, see `LICENSE`. Third-party: `vendor/zxing-wasm` is MIT (zxing-wasm) and Apache-2.0 (zxing-cpp), see `vendor/zxing-wasm/NOTICE`.
