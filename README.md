<div align="center">
  <img src="./src/css/hydraulic.png" alt="Hydraulic" width="156" height="156" />
  <h1>Hydraulic - Discord Video Compressor</h1> 
  

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

Hydraulic is a lightweight desktop app for viewing, trimming and compressing gaming clips for easier sharing to Discord. Hydraulic brings the clip managing functionality of apps like Medal and SteelSeries GG to all your clips.


[![Get the latest installer](https://img.shields.io/badge/Get%20latest%20installer-Releases-2ea44f?style=for-the-badge&logo=github)](https://github.com/Astromations/Hydraulic/releases)

## Screenshots 🖼️

### 🔼 Drag & 🫳 Drop to Add Clips to Queue

<img width="1125" height="900" alt="image" src="https://github.com/user-attachments/assets/116d9034-64e0-4228-af46-d5e2265fda61" />



### 📺 Preview Clips Before Compressing

<img width="1125" height="900" alt="image" src="https://github.com/user-attachments/assets/bb3858fa-ce45-47df-b001-14483420fab9" />


### ✂️ Trim Clips and 🔉 Toggle Audio Tracks

<img width="1125" height="900" alt="image" src="https://github.com/user-attachments/assets/1863843f-1edc-4bfc-936a-3e58f0d794ef" />



### ✂️ Open Clips Directly in Hydraulic

<img width="867" height="749" alt="image" src="https://github.com/user-attachments/assets/9ab297e9-dbea-4265-8c4d-a6e63e150f2b" />

## 🔽 Download

Installers are published on the project releases page:

- https://github.com/Astromations/Hydraulic/releases

### Windows PowerShell Installer [Untested]

Run this command in PowerShell to download the installer from the latest GitHub release and start it with administrator permission:

```powershell
iwr -useb https://raw.githubusercontent.com/Astromations/Hydraulic/refs/heads/main/install.ps1 | iex
```


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
