# Frame-level flash diagnostic (fast GDI StretchBlt path, ~100 fps at 640x360).
# Captures the WHOLE Windows desktop around a synthetic right-click on the pet
# window, then reports and saves the frames that deviate most from the pre-click
# reference frame.
param(
  [string]$OutDir = "$env:TEMP\ice-frames",
  [int]$Width = 640,
  [int]$Height = 360,
  [int]$PostFrames = 120,
  [int]$PreFrames = 10,
  [double]$MinScore = 0.6
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;

public class FastCap : IDisposable {
  [StructLayout(LayoutKind.Sequential)]
  public struct BITMAPINFOHEADER {
    public uint biSize; public int biWidth; public int biHeight; public ushort biPlanes;
    public ushort biBitCount; public uint biCompression; public uint biSizeImage;
    public int biXPelsPerMeter; public int biYPelsPerMeter; public uint biClrUsed; public uint biClrImportant;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct BITMAPINFO { public BITMAPINFOHEADER bmiHeader; public uint bmiColors; }

  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hWnd);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFO bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);
  [DllImport("gdi32.dll")] static extern int SetStretchBltMode(IntPtr hdc, int mode);
  [DllImport("gdi32.dll")] static extern bool StretchBlt(IntPtr dst, int dx, int dy, int dw, int dh, IntPtr src, int sx, int sy, int sw, int sh, uint rop);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  IntPtr hdcScreen, hdcMem, hbmp, oldBmp, bits;
  int width, height;
  byte[] buffer;

  public FastCap(int w, int h) {
    width = w; height = h;
    hdcScreen = GetDC(IntPtr.Zero);
    hdcMem = CreateCompatibleDC(hdcScreen);
    var bmi = new BITMAPINFO();
    bmi.bmiHeader.biSize = (uint)Marshal.SizeOf(typeof(BITMAPINFOHEADER));
    bmi.bmiHeader.biWidth = w;
    bmi.bmiHeader.biHeight = -h; // top-down
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = 0;
    hbmp = CreateDIBSection(hdcScreen, ref bmi, 0, out bits, IntPtr.Zero, 0);
    oldBmp = SelectObject(hdcMem, hbmp);
    SetStretchBltMode(hdcMem, 3); // COLORONCOLOR
    buffer = new byte[w * h * 4];
  }

  public byte[] Grab(int screenW, int screenH) {
    bool ok = StretchBlt(hdcMem, 0, 0, width, height, hdcScreen, 0, 0, screenW, screenH, 0x00CC0020);
    if (!ok) ok = StretchBlt(hdcMem, 0, 0, width, height, hdcScreen, 0, 0, screenW, screenH, 0x00CC0020);
    Marshal.Copy(bits, buffer, 0, buffer.Length);
    for (int i = 3; i < buffer.Length; i += 4) buffer[i] = 255;
    return (byte[])buffer.Clone();
  }

  public static void LeftClick(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(30);
    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);
    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);
  }

  public static void RightClick(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(30);
    mouse_event(0x0008, 0, 0, 0, IntPtr.Zero);
    mouse_event(0x0010, 0, 0, 0, IntPtr.Zero);
  }

  public static RECT PetRect(IntPtr hwnd) { RECT r; GetWindowRect(hwnd, out r); return r; }
  public static int ScreenWidth() { return GetSystemMetrics(0); }
  public static int ScreenHeight() { return GetSystemMetrics(1); }

  public void Dispose() {
    SelectObject(hdcMem, oldBmp);
    DeleteObject(hbmp);
    DeleteDC(hdcMem);
    ReleaseDC(IntPtr.Zero, hdcScreen);
  }
}
"@

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
$screenW = [FastCap]::ScreenWidth()
$screenH = [FastCap]::ScreenHeight()

$pet = Get-Process ice-agent -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $pet) { "ice-agent is not running"; exit 1 }
$rect = [FastCap]::PetRect($pet.MainWindowHandle)
$clickX = [int](($rect.Left + $rect.Right) / 2)
$clickY = [int](($rect.Top + $rect.Bottom) / 2)
"screen ${screenW}x${screenH}; capture ${Width}x${Height}; click $clickX,$clickY"

# Click the desktop first so a previously opened menu is closed before the test.
[FastCap]::LeftClick(60, 60)
Start-Sleep -Milliseconds 600

$cap = New-Object FastCap $Width, $Height
$frames = New-Object System.Collections.ArrayList
$times = New-Object System.Collections.ArrayList
$sw = [System.Diagnostics.Stopwatch]::StartNew()

Start-Sleep -Milliseconds 300
for ($i = 0; $i -lt $PreFrames; $i++) { [void]$frames.Add($cap.Grab($screenW, $screenH)); [void]$times.Add($sw.Elapsed.TotalMilliseconds) }

[FastCap]::RightClick($clickX, $clickY)
$clickAt = $sw.Elapsed.TotalMilliseconds

for ($i = 0; $i -lt $PostFrames; $i++) { [void]$frames.Add($cap.Grab($screenW, $screenH)); [void]$times.Add($sw.Elapsed.TotalMilliseconds) }
$cap.Dispose()

$refIndex = $PreFrames - 1
$ref = $frames[$refIndex]
$results = New-Object System.Collections.ArrayList
for ($i = $PreFrames; $i -lt $frames.Count; $i++) {
  $bytes = $frames[$i]
  $sum = 0.0
  $count = 0
  for ($p = 0; $p -lt $bytes.Length; $p += 32) {
    $d = [int]$bytes[$p] - [int]$ref[$p]
    if ($d -lt 0) { $d = -$d }
    $sum += $d
    $count++
  }
  [void]$results.Add([pscustomobject]@{
    Index = $i
    AfterClickMs = [math]::Round($times[$i] - $clickAt, 1)
    Score = [math]::Round($sum / $count, 2)
  })
}

$fps = [math]::Round(($frames.Count - 1) / (($times[$times.Count - 1] - $times[0]) / 1000), 1)
"captured $($frames.Count) frames at ~$fps fps; click at +0ms"
$results | Sort-Object Score -Descending | Select-Object -First 10 | Format-Table -AutoSize | Out-String

# Time series immediately after the click: this is where a one-frame flash lives.
$early = $results | Where-Object { $_.AfterClickMs -le 420 }
"transition series (first 420ms):"
($early | ForEach-Object { "{0,6}ms:{1,5}" -f $_.AfterClickMs, $_.Score }) -join "  " | Out-String
$k = 0
foreach ($item in $early) {
  $bytes = $frames[$item.Index]
  $bmp = New-Object System.Drawing.Bitmap $Width, $Height
  $data = $bmp.LockBits(
    (New-Object System.Drawing.Rectangle 0, 0, $Width, $Height),
    [System.Drawing.Imaging.ImageLockMode]::WriteOnly,
    [System.Drawing.Imaging.PixelFormat]::Format32bppRgb)
  [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $data.Scan0, $bytes.Length)
  $bmp.UnlockBits($data)
  $bmp.Save((Join-Path $OutDir ("early_{0}_t{1}ms.png" -f $k, $item.AfterClickMs)), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $k++
}
"early frames saved: $k"

$saved = 0
foreach ($item in ($results | Sort-Object Score -Descending)) {
  if ($item.Score -lt $MinScore -or $saved -ge 4) { continue }
  $bytes = $frames[$item.Index]
  $bmp = New-Object System.Drawing.Bitmap $Width, $Height
  $data = $bmp.LockBits(
    (New-Object System.Drawing.Rectangle 0, 0, $Width, $Height),
    [System.Drawing.Imaging.ImageLockMode]::WriteOnly,
    [System.Drawing.Imaging.PixelFormat]::Format32bppRgb)
  [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $data.Scan0, $bytes.Length)
  $bmp.UnlockBits($data)
  $file = Join-Path $OutDir ("flash_{0}_t{1}ms_score{2}.png" -f $saved, $item.AfterClickMs, $item.Score)
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  "saved $file"
  $saved++
}
if ($saved -eq 0) { "no frame exceeded the score threshold ($MinScore)" }

$bmp = New-Object System.Drawing.Bitmap $Width, $Height
$data = $bmp.LockBits(
  (New-Object System.Drawing.Rectangle 0, 0, $Width, $Height),
  [System.Drawing.Imaging.ImageLockMode]::WriteOnly,
  [System.Drawing.Imaging.PixelFormat]::Format32bppRgb)
[System.Runtime.InteropServices.Marshal]::Copy($ref, 0, $data.Scan0, $ref.Length)
$bmp.UnlockBits($data)
$bmp.Save((Join-Path $OutDir "reference.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
"reference saved to $OutDir"
