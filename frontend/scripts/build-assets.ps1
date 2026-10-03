Add-Type -AssemblyName System.Drawing

# ─────────────────────────────────────────────────────────────────────────────
# Beast-Trader brand asset builder
#
# Takes the two supplied masters and emits every size the app, the browser and
# social platforms ask for. Run it after replacing a master:
#
#   powershell -File scripts\build-assets.ps1
#
# Colours below were sampled from the masters themselves (median of the border
# pixels), not guessed, so the splash background always matches the artwork.
# ─────────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = 'Stop'
$root    = Split-Path -Parent $PSScriptRoot
$logos   = Join-Path $root 'public\logos'
$brand   = Join-Path $root 'public'

# Sampled from the source images (median border colour).
$MARK_BG  = [System.Drawing.Color]::FromArgb(255, 0x0C, 0x17, 0x29)  # logo.jpg
$WORD_BG  = [System.Drawing.Color]::FromArgb(255, 0x05, 0x0D, 0x1F)  # logo_w_text.jpg

# Content bounding boxes measured from the masters, as (x, y, w, h).
$MARK_BOX = @(182, 168, 656, 702)
$WORD_BOX = @(196, 180, 708, 696)

function Save-Png($bmp, [string]$path) {
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Host ("  {0,-34} {1,7:N0} bytes" -f (Split-Path $path -Leaf), (Get-Item $path).Length)
}

# Artwork is photographic (soft glow on a dark field), so PNG encodes it very
# poorly — a 1.4MB splash drops to ~90KB as JPEG. Icons stay PNG because
# launchers require transparency and crisp small sizes.
function Save-Jpeg($bmp, [string]$path, [int]$quality = 88) {
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
        Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
    $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
        [System.Drawing.Imaging.Encoder]::Quality, [long]$quality)
    $bmp.Save($path, $codec, $params)
    $params.Dispose()
    Write-Host ("  {0,-34} {1,7:N0} bytes" -f (Split-Path $path -Leaf), (Get-Item $path).Length)
}

function New-Gfx($bmp) {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    return $g
}

# Draw a high-quality centred crop of a master region, squared off so the mark
# is never distorted.
function Write-Crop($src, [int[]]$box, [int]$size, [string]$out, [double]$padPct = 0.06) {
    $img = [System.Drawing.Image]::FromFile($src)
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = New-Gfx $bmp
    $side = [Math]::Max($box[2], $box[3])
    $cx = $box[0] + $box[2] / 2
    $cy = $box[1] + $box[3] / 2
    $half = $side * (0.5 + $padPct)
    $srcRect = [System.Drawing.RectangleF]::new(
        [float][Math]::Max(0, $cx - $half), [float][Math]::Max(0, $cy - $half), [float]($half * 2), [float]($half * 2))
    $dstRect = [System.Drawing.RectangleF]::new(0, 0, [float]$size, [float]$size)
    $g.DrawImage($img, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose(); $img.Dispose()
    Save-Png $bmp $out
    $bmp.Dispose()
}

# Flat colour canvas, for backgrounds that must match the artwork exactly.
function Write-Canvas($color, [int]$w, [int]$h, [string]$out) {
    $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear($color)
    $g.Dispose()
    Save-Png $bmp $out
    $bmp.Dispose()
}

# Centre `logo_w_text` on a canvas, scaled to fit inside a box.
#
# The master is a 1024px square with wide empty margins, so it is cropped to
# its measured content box first. Fitting is "contain" against BOTH a width and
# a height budget: a wide social card scaled purely by width would overflow a
# 630px-tall canvas and slice the ears off the wolf.
function Write-Wordmark([string]$out, [int]$w, [int]$h, [double]$wFrac, [double]$hFrac = $wFrac) {
    $img = [System.Drawing.Image]::FromFile((Join-Path $logos 'logo_w_text.jpg'))
    $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = New-Gfx $bmp
    $g.Clear($WORD_BG)

    $side = [Math]::Max($WORD_BOX[2], $WORD_BOX[3])
    $cx = $WORD_BOX[0] + $WORD_BOX[2] / 2
    $cy = $WORD_BOX[1] + $WORD_BOX[3] / 2
    # 0.58 keeps the faint outer glow inside the crop, not just the hard lines.
    $half = $side * 0.58
    $srcRect = [System.Drawing.RectangleF]::new(
        [float][Math]::Max(0, $cx - $half), [float][Math]::Max(0, $cy - $half),
        [float]($half * 2), [float]($half * 2))

    # Contain: whichever budget binds first decides the scale.
    $byW = $w * $wFrac
    $byH = $h * $hFrac
    $scale = [Math]::Min($byW / $srcRect.Width, $byH / $srcRect.Height)
    $dw = [float]($srcRect.Width * $scale)
    $dh = [float]($srcRect.Height * $scale)
    $g.DrawImage($img, [System.Drawing.RectangleF]::new(($w - $dw) / 2, ($h - $dh) / 2, $dw, $dh),
                 $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose(); $img.Dispose()
    Save-Jpeg $bmp $out
    $bmp.Dispose()
}

# Multi-resolution .ico assembled from PNG payloads (supported by every
# current browser, and avoids needing a native icon encoder).
function Write-Ico([int[]]$sizes, [string]$out) {
    $images = @()
    foreach ($s in $sizes) { $images += ,@($s, (Join-Path $brand "favicon-$s.png")) }
    $count = $images.Count
    $header = New-Object byte[] 6
    $header[2] = 1; $header[4] = $count
    $ms = New-Object System.IO.MemoryStream
    $ms.Write($header, 0, 6)
    $offset = 6 + 16 * $count
    foreach ($pair in $images) {
        $bytes = [System.IO.File]::ReadAllBytes($pair[1])
        $e = New-Object byte[] 16
        $e[0] = [byte]($pair[0] -band 0xFF)
        $e[1] = [byte]($pair[0] -shr 8)
        [BitConverter]::GetBytes([int]$bytes.Length).CopyTo($e, 4)
        [BitConverter]::GetBytes([int]$offset).CopyTo($e, 8)
        $ms.Write($e, 0, 16)
        $offset += $bytes.Length
    }
    foreach ($pair in $images) {
        $bytes = [System.IO.File]::ReadAllBytes($pair[1])
        $ms.Write($bytes, 0, $bytes.Length)
    }
    [System.IO.File]::WriteAllBytes($out, $ms.ToArray())
    $ms.Dispose()
    Write-Host ("  {0,-34} {1,7:N0} bytes" -f (Split-Path $out -Leaf), (Get-Item $out).Length)
}

# Maskable icons must keep the mark inside the 80% safe zone or the launcher
# crops it, so the art is inset on a full-bleed background.
function Write-Maskable([int]$size, [string]$out) {
    $img = [System.Drawing.Image]::FromFile((Join-Path $logos 'logo.jpg'))
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = New-Gfx $bmp
    $g.Clear($MARK_BG)
    $dw = $size * 0.62
    $g.DrawImage($img, ($size - $dw) / 2, ($size - $dw) / 2, $dw, $dw)
    $g.Dispose(); $img.Dispose()
    Save-Png $bmp $out
    $bmp.Dispose()
}

# ── Favicons ────────────────────────────────────────────────────────────────
Write-Host "`nFavicons"
$markSrc = Join-Path $logos 'logo.jpg'
foreach ($s in 16, 32, 48, 64, 96, 128, 192, 256) {
    Write-Crop $markSrc $MARK_BOX $s (Join-Path $brand "favicon-$s.png")
}
# The home-screen icon wants the mark filling the tile, so less padding.
Write-Crop $markSrc $MARK_BOX 180 (Join-Path $brand 'apple-touch-icon.png') 0.02
Write-Ico 16, 32, 48, 64, 128, 256 (Join-Path $brand 'favicon.ico')

# ── App / PWA icons ─────────────────────────────────────────────────────────
Write-Host "`nApp icons"
Write-Maskable 192 (Join-Path $brand 'icon-192.png')
Write-Maskable 512 (Join-Path $brand 'icon-512.png')

# ── Social share images ─────────────────────────────────────────────────────
Write-Host "`nSocial"
# Wide cards: fit mostly by height so the whole lock-up stays visible.
Write-Wordmark (Join-Path $brand 'og-image.jpg') 1200 630 0.60 0.72
Write-Wordmark (Join-Path $brand 'twitter-card.jpg') 1200 600 0.60 0.72

# ── Splash screens ──────────────────────────────────────────────────────────
Write-Host "`nSplash screens (background sampled from logo_w_text.jpg)"
$splashDir = Join-Path $brand 'splash'
New-Item -ItemType Directory -Force -Path $splashDir | Out-Null
$splashes = @(
    @{ n = 'iphone-portrait';  w = 1290; h = 2796 },
    @{ n = 'iphone-pro';       w = 1179; h = 2556 },
    @{ n = 'iphone-landscape'; w = 2796; h = 1290 },
    @{ n = 'ipad-portrait';    w = 2048; h = 2732 },
    @{ n = 'ipad-landscape';   w = 2732; h = 2048 },
    @{ n = 'android';          w = 1080; h = 1920 }
)
foreach ($s in $splashes) {
    # Portrait sits a little above centre, the way launchers expect, and the
    # wordmark is capped by width so it never runs off the sides.
    if ($s.h -gt $s.w) {
        Write-Wordmark (Join-Path $splashDir "$($s.n).jpg") $s.w $s.h 0.80 0.80
    } else {
        Write-Wordmark (Join-Path $splashDir "$($s.n).jpg") $s.w $s.h 0.60 0.80
    }
}

# ── Theme metadata, so the PWA installer matches the artwork ───────────────
$hex = '#{0:X2}{1:X2}{2:X2}' -f $WORD_BG.R, $WORD_BG.G, $WORD_BG.B
$markHex = '#{0:X2}{1:X2}{2:X2}' -f $MARK_BG.R, $MARK_BG.G, $MARK_BG.B
$manifest = @"
{
  "name": "Beast-Trader",
  "short_name": "Beast",
  "description": "Follow the coins you care about. Beast watches them for you.",
  "start_url": "/",
  "display": "standalone",
  "background_color": "$hex",
  "theme_color": "$hex",
  "orientation": "any",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
"@
[System.IO.File]::WriteAllText((Join-Path $brand 'manifest.webmanifest'), $manifest)
Write-Host ("`nmanifest.webmanifest background_color {0} | theme_color {1}" -f $hex, $hex)
Write-Host "wordmark background $hex | mark background $markHex`n"
