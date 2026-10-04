<div align="center">
  <img src="peak.png" alt="Hydraulic" width="128" height="128" />
  <h1>Hydraulic</h1>
  <p><strong>Discord Video Compressor</strong></p>

  <p>
    <a href="https://github.com/Astromations/Hydraulic">
      <img alt="Release" src="https://img.shields.io/github/v/release/Astromations/Hydraulic?style=for-the-badge" />
    </a>
    <img alt="Windows/macOS/Linux" src="https://img.shields.io/badge/OS-Windows%20%7C%20macOS%20%7C%20Linux-5865F2?style=for-the-badge" />
    <img alt="Last update" src="https://img.shields.io/github/last-commit/Astromations/Hydraulic?label=Updated&style=for-the-badge" />
    <img alt="License" src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" />
  </p>
</div>

Hydraulic is a lightweight desktop app for shrinking videos to a Discord-friendly size while keeping the output watchable and easy to share. Drag in a file, select a target size, and export a compressed MP4 in a few clicks.

[![Get the latest installer](https://img.shields.io/badge/Get%20latest%20installer-Releases-2ea44f?style=for-the-badge&logo=github)](https://github.com/Astromations/Hydraulic/releases)

## Features

- Simple drag-and-drop workflow
- Target-size compression for Discord uploads
- FFmpeg-powered conversion for strong compression quality
- Cross-platform desktop app built with Tauri
- Exported files saved alongside the original with a compressed suffix

## Requirements

- Windows, macOS, or Linux
- FFmpeg bundled with the app for the packaged builds
- A supported video file such as MP4, MOV, or MKV

## Download

Installers are published on the project releases page:

- https://github.com/Astromations/Hydraulic/releases

## Build from source

```bash
cargo tauri build
```

This will generate a release build in the Tauri build output directory. The app bundles FFmpeg resources for the packaged installer so users do not need to install FFmpeg separately.

## Notes

- Output files are saved next to the original with `_compressed` added to the filename.
- If compression quality is poor for a particular source, lower the target size or disable GPU acceleration if your hardware does not support it.
- This project is distributed under the MIT License.
