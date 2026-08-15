# make-icon.ps1 - high-quality icons via GDI+ (antialiased gradient + letter + gloss)
# outputs: resources/icon.png(1024) resources/tray.png(64) resources/icon.ico(16..256)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$ROOT = Split-Path -Parent $PSScriptRoot
$RES = Join-Path $ROOT 'resources'
$TMP = Join-Path $ROOT '.tmp\icons'
New-Item -ItemType Directory -Force -Path $RES, $TMP | Out-Null

function New-RoundedRectPath {
  param([float]$x, [float]$y, [float]$w, [float]$h, [float]$r)
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function New-IconPng {
  param([int]$Size, [string]$OutPath, [float]$RadiusRatio = 0.22, [float]$FontRatio = 0.60, [int]$CanvasSize = 0)
  if ($CanvasSize -eq 0) { $CanvasSize = $Size }
  $bmp = New-Object System.Drawing.Bitmap($CanvasSize, $CanvasSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

  $S = [float]$CanvasSize
  $path = New-RoundedRectPath 0 0 $S $S ($S * $RadiusRatio)

  # blue-violet diagonal gradient
  $rect = New-Object System.Drawing.RectangleF -ArgumentList 0, 0, $S, $S
  $c1 = [System.Drawing.Color]::FromArgb(255, 79, 140, 255)   # #4F8CFF
  $c2 = [System.Drawing.Color]::FromArgb(255, 124, 108, 255) # #7C6CFF
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, 48)
  $g.FillPath($grad, $path)

  # top gloss (ellipse gradient)
  $hlRect = New-Object System.Drawing.RectangleF -ArgumentList ($S * 0.08), ($S * 0.05), ($S * 0.86), ($S * 0.42)
  $hlA = [System.Drawing.Color]::FromArgb(85, 255, 255, 255)
  $hlB = [System.Drawing.Color]::FromArgb(0, 255, 255, 255)
  $hlBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($hlRect, $hlA, $hlB, 90)
  $g.FillEllipse($hlBrush, $hlRect)

  # bottom inner shadow (depth)
  $shRect = New-Object System.Drawing.RectangleF -ArgumentList 0, ($S * 0.72), $S, ($S * 0.28)
  $shA = [System.Drawing.Color]::FromArgb(40, 0, 0, 0)
  $shB = [System.Drawing.Color]::FromArgb(0, 0, 0, 0)
  $shBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($shRect, $shA, $shB, 90)
  $shPath = New-RoundedRectPath 0 ($S * 0.72) $S ($S * 0.28) ($S * 0.22)
  $g.FillPath($shBrush, $shPath)

  # white bold letter D with soft shadow
  $fontSize = [math]::Max(10, [int]($S * $FontRatio))
  $font = New-Object System.Drawing.Font('Segoe UI', $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center

  # letter shadow (offset right-down 1.5%)
  $shadow = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(70, 0, 0, 0))
  $sc = New-Object System.Drawing.PointF -ArgumentList ($S * 0.515), ($S * 0.535)
  $g.DrawString('D', $font, $shadow, $sc, $fmt)

  $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $center = New-Object System.Drawing.PointF -ArgumentList ($S * 0.5), ($S * 0.5)
  $g.DrawString('D', $font, $white, $center, $fmt)

  # thin border
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(55, 255, 255, 255), [math]::Max(1.0, $S * 0.004))
  $g.DrawPath($pen, $path)

  $g.Dispose()

  if ($CanvasSize -eq $Size) {
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    [System.IO.File]::WriteAllBytes($OutPath, $ms.ToArray())
    $ms.Dispose()
  } else {
    # high-quality downscale (small ICO sizes render from the 256 canvas)
    $dest = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $dg = [System.Drawing.Graphics]::FromImage($dest)
    $dg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $dg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $dg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $dg.DrawImage($bmp, 0, 0, $Size, $Size)
    $dg.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $dest.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    [System.IO.File]::WriteAllBytes($OutPath, $ms.ToArray())
    $ms.Dispose()
    $dest.Dispose()
  }
  $bmp.Dispose()
  Write-Host "generated: $OutPath ($Size x $Size)"
}

# main icon
New-IconPng 1024 (Join-Path $RES 'icon.png')

# tray icon (Windows tray scales to 16/24)
New-IconPng 64 (Join-Path $RES 'tray.png') 0.22 0.56

# ICO multi-size (PNG entries, Vista+/NSIS3 compatible)
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$pngMap = @{}
foreach ($s in $sizes) {
  $tmpFile = Join-Path $TMP "ico-$s.png"
  New-IconPng $s $tmpFile 0.22 0.60 256   # render on 256 canvas, then downscale
  $pngMap[$s] = [System.IO.File]::ReadAllBytes($tmpFile)
}

$ico = Join-Path $RES 'icon.ico'
$fs = [System.IO.File]::Create($ico)
try {
  $bw = New-Object System.IO.BinaryWriter($fs)
  $bw.Write([uint16]0)          # reserved
  $bw.Write([uint16]1)          # type: icon
  $bw.Write([uint16]$sizes.Count)
  $offset = 6 + 16 * $sizes.Count
  foreach ($s in $sizes) {
    $data = $pngMap[$s]
    $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
    $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
    $bw.Write([byte]0)          # palette
    $bw.Write([byte]0)          # reserved
    $bw.Write([uint16]1)        # planes
    $bw.Write([uint16]32)       # bpp
    $bw.Write([uint32]$data.Length)
    $bw.Write([uint32]$offset)
    $offset += $data.Length
  }
  foreach ($s in $sizes) {
    $bw.Write($pngMap[$s])
  }
  $bw.Flush()
} finally {
  $fs.Dispose()
}
Write-Host "generated: $ico (sizes $($sizes -join '/'))"
Remove-Item $TMP -Recurse -Force -ErrorAction SilentlyContinue
