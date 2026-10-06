<div align="center">
  <img src="peak.png" alt="Hydraulic" width="128" height="128" />
  <h1>Hydraulic</h1>
  <p><strong>Discord Video Compressor</strong></p>

  <p>
    <a href="https://github.com/Astromations/Hydraulic">
        <img alt="GitHub Release" src="https://img.shields.io/github/v/release/Astromations/Hydraulic?style=for-the-badge&color=%235865f2" />

  </a>
    <img alt="Windows" src="https://img.shields.io/badge/OS-Windows-0078D6?style=for-the-badge" />
    <img alt="Last update" src="https://img.shields.io/github/last-commit/Astromations/Hydraulic?label=Updated&style=for-the-badge"/>
    <img alt="License" src="https://img.shields.io/badge/License-MIT-orange?style=for-the-badge" />

  </p>
</div>

## 👀 About

Hydraulic is a lightweight desktop app for viewing, trimming and compressing gaming clips for easier sharing to Discord. For all those who don't use Medal or Steelseries, compressing clips can be a hassle, trimming them even more so. Hydraulic brings the clip managing functionality of those apps to all your clips.

It's essentially a pretty ffmpeg wrapper built in rust.

[![Get the latest installer](https://img.shields.io/badge/Get%20latest%20installer-Releases-2ea44f?style=for-the-badge&logo=github)](https://github.com/Astromations/Hydraulic/releases)

## Screenshots 🖼️

### 🔼 Drag & 🫳 Drop to Add Clips to Queue

<img width="1125" height="900" alt="image" src="https://github.com/user-attachments/assets/2356f288-7063-462d-b618-cbc2da9489f4" />

### 📺 Preview Clips Before Compressing

<img width="1125" height="900" alt="image" src="https://github.com/user-attachments/assets/5c7a440a-ac31-458f-ae49-d346987536c3" />

### ✂️ Trim Clips and 🔉 Toggle Audio Tracks

<img width="1125" height="900" alt="image" src="https://github.com/user-attachments/assets/378db77b-7a26-4b12-9b7e-4becea6f568b" />

### ✂️ Open Clips Directly in Hydraulic

<img width="867" height="749" alt="image" src="https://github.com/user-attachments/assets/9ab297e9-dbea-4265-8c4d-a6e63e150f2b" />

## 🔽 Download

Installers are published on the project releases page:

- https://github.com/Astromations/Hydraulic/releases

### Windows PowerShell installer

Run this command in PowerShell to download the installer from the latest GitHub release and start it with administrator permission:

```powershell
iwr https://raw.githubusercontent.com/Astromations/Peak---Video-Compressor/rust/install.ps1 -UseBasicParsing | iex
```

To use a local installer instead, download `install.ps1` and pass the installer path as the first argument:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 .\Hydraulic_2.0.0_x64-setup.exe
```

The script prefers a local `.exe` or `.msi` beside it. If none is present, it downloads the latest Windows `.exe` or `.msi` release asset to a temporary folder, launches it, and removes the temporary file afterward.

## 🧱 Build from Source

```bash
cargo tauri build
```

This will generate a release build in the Tauri build output directory. The app bundles FFmpeg resources for the packaged installer so users do not need to install FFmpeg separately.

## 📝 Notes

- Output files are saved next to the original with `_compressed` added to the filename.
- Target size might not be met for long videos being exported into very small sizes.
- If compression quality is poor for a particular source, increase the target size or disable GPU acceleration if your hardware does not support it.
- This project is distributed under the MIT License.
