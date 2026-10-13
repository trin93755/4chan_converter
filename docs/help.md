# Opening the app

Extract the whole download into a writable folder, such as Documents. Keep its files together.

| Computer | Open |
| --- | --- |
| Windows | Double-click **Start.bat**. |
| Mac | Double-click **Start.command**. Choose the download matching **Apple menu → About This Mac → Chip / Processor**. |
| Linux | Open **Start.sh** and choose **Run as a program**. If it opens as text, open a terminal in that folder and run `sh Start.sh`. |

The first launch downloads and verifies FFmpeg and FFprobe. Leave the window open until your browser appears. If the download fails, open Start again; completed downloads are reused. No account, administrator rights, Node installation, or FFmpeg installation is needed.

If the browser does not open, copy the complete local address from the launcher into your browser. Keep the launcher running; use **Quit** in the app when finished.

## OS approval

These downloads are unsigned. Windows or macOS may ask you to approve the downloaded program. Only open a package you trust. Do not disable your system’s security protections.

On macOS, follow [Apple’s instructions for opening an app from an unidentified developer](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unidentified-developer-mh40616/mac). If your organization manages the device, its policy may prevent unsigned software from running.

## Files and privacy

- Videos stay on your computer. Originals are never changed.
- Exports are saved in **outputs** beside Start. Change this in **Advanced**.
- **Catbox audio** is optional and public. A local MP3 is also saved.
- Clips longer than the limit are split automatically. Advanced can instead skip them.
- Use **Download ZIP** to collect the finished batch.

## Update or remove

Extract a new release into a new folder. Keep your old **outputs** folder if you need those files. Remove the extracted app folder to uninstall; there is no system service.

The packages follow the bundled [runtime’s system requirements](https://github.com/nodejs/node/blob/v24.21.0/BUILDING.md#platform-list): 64-bit Windows 10/11, macOS 13.5 or newer, and mainstream Linux distributions with glibc 2.28 or newer. Alpine/musl and 32-bit systems are not included. Platform verification is recorded in [GitHub Actions](https://github.com/trin93755/4chan_converter/actions).
