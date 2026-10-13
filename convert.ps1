# ============================================================
# Recursive MP4 -> 4chan WebM Converter
# Reads settings from converter_config.txt
#
# Always creates a silent VP9 WebM below 4,000,000 bytes.
# CATBOX_UPLOAD=YES: extract MP3, upload to Catbox, name WebM with
#                    Base64url(UTF-8 Catbox URL) + ".webm".
# CATBOX_UPLOAD=NO:  skip MP3/upload, use a random 15-digit WebM name.
# DELETE_SOURCE=YES: delete original MP4 only after success.
#
# Requires: Windows PowerShell 5.1+, FFmpeg, FFprobe.
# When Catbox is enabled, also requires curl.exe (included in Windows 10/11).
# Optional converter_config.txt key: CATBOX_USERHASH=...
# ============================================================

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $ScriptDir "converter_config.txt"

if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "Configuration file not found: $ConfigPath"
}

function Read-ConverterConfig {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $settings = @{}

    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()

        if ([string]::IsNullOrWhiteSpace($trimmed)) { continue }
        if ($trimmed.StartsWith("#")) { continue }

        $eq = $trimmed.IndexOf("=")
        if ($eq -lt 1) { continue }

        $key = $trimmed.Substring(0, $eq).Trim()
        $value = $trimmed.Substring($eq + 1).Trim()

        if (
            ($value.StartsWith('"') -and $value.EndsWith('"')) -or
            ($value.StartsWith("'") -and $value.EndsWith("'"))
        ) {
            $value = $value.Substring(1, $value.Length - 2)
        }

        $settings[$key.ToUpperInvariant()] = $value
    }

    return $settings
}

function Convert-ToBooleanSetting {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value,
        [Parameter(Mandatory = $true)]
        [string]$SettingName
    )

    switch ($Value.Trim().ToUpperInvariant()) {
        "YES"   { return $true }
        "TRUE"  { return $true }
        "1"     { return $true }
        "ON"    { return $true }

        "NO"    { return $false }
        "FALSE" { return $false }
        "0"     { return $false }
        "OFF"   { return $false }

        default {
            throw "$SettingName must be YES or NO."
        }
    }
}

$Config = Read-ConverterConfig -Path $ConfigPath

if (-not $Config.ContainsKey("INPUT_DIR")) {
    throw "converter_config.txt is missing INPUT_DIR="
}

if (-not $Config.ContainsKey("OUTPUT_DIR")) {
    throw "converter_config.txt is missing OUTPUT_DIR="
}

if (-not $Config.ContainsKey("DELETE_SOURCE")) {
    throw "converter_config.txt is missing DELETE_SOURCE=YES or DELETE_SOURCE=NO"
}

$InputDir = $Config["INPUT_DIR"]
$OutputDir = $Config["OUTPUT_DIR"]
$DeleteSource = Convert-ToBooleanSetting `
    -Value $Config["DELETE_SOURCE"] `
    -SettingName "DELETE_SOURCE"

# When omitted (in an older config), Catbox remains disabled.
$EnableCatbox = $false
if ($Config.ContainsKey("CATBOX_UPLOAD")) {
    $EnableCatbox = Convert-ToBooleanSetting `
        -Value $Config["CATBOX_UPLOAD"] `
        -SettingName "CATBOX_UPLOAD"
}

# Optional: attach uploads to your Catbox account. Anonymous is the default.
$CatboxUserHash = ""
if ($Config.ContainsKey("CATBOX_USERHASH")) {
    $CatboxUserHash = $Config["CATBOX_USERHASH"].Trim()
}

if ([string]::IsNullOrWhiteSpace($InputDir)) {
    throw "INPUT_DIR is empty in converter_config.txt"
}

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    throw "OUTPUT_DIR is empty in converter_config.txt"
}

$TargetBytes = 3900000
$HardMaxBytes = 4000000
$MaxAttempts = 10
$AudioBitrateKbps = 128
$CatboxApiUrl = "https://catbox.moe/user/api.php"

Write-Host ""
Write-Host "Input folder :" -ForegroundColor Cyan
Write-Host $InputDir
Write-Host ""
Write-Host "Output folder:" -ForegroundColor Cyan
Write-Host $OutputDir
Write-Host ""
Write-Host ("Delete source after success: {0}" -f $(if ($DeleteSource) { "YES" } else { "NO" })) -ForegroundColor Cyan
Write-Host ("Catbox MP3 upload: {0}" -f $(if ($EnableCatbox) { "YES" } else { "NO" })) -ForegroundColor Cyan
if ($EnableCatbox) {
    Write-Host ("Catbox account upload: {0}" -f $(if ($CatboxUserHash) { "YES" } else { "NO (anonymous)" })) -ForegroundColor Cyan
}
Write-Host ""

if (-not (Test-Path -LiteralPath $InputDir)) {
    throw "Input directory does not exist: $InputDir"
}

if (-not (Test-Path -LiteralPath $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

$ffmpegCommand = Get-Command "ffmpeg.exe" -ErrorAction SilentlyContinue
if (-not $ffmpegCommand) {
    $ffmpegCommand = Get-Command "ffmpeg" -ErrorAction SilentlyContinue
}

$ffprobeCommand = Get-Command "ffprobe.exe" -ErrorAction SilentlyContinue
if (-not $ffprobeCommand) {
    $ffprobeCommand = Get-Command "ffprobe" -ErrorAction SilentlyContinue
}

if (-not $ffmpegCommand -or -not $ffprobeCommand) {
    Write-Host ""
    Write-Host "FFmpeg or FFprobe was not found." -ForegroundColor Red
    Write-Host ""
    Write-Host "Install FFmpeg with:"
    Write-Host "winget install --id Gyan.FFmpeg -e" -ForegroundColor Cyan
    Write-Host ""
    exit 1
}

$FFmpeg = $ffmpegCommand.Source
$FFprobe = $ffprobeCommand.Source

function Get-RandomOutputPath {
    # Classic converter filename when CATBOX_UPLOAD=NO.
    do {
        $digits = ""
        for ($i = 0; $i -lt 15; $i++) {
            $digits += (Get-Random -Minimum 0 -Maximum 10).ToString()
        }
        $path = Join-Path $OutputDir ($digits + ".webm")
    }
    while (Test-Path -LiteralPath $path)

    return $path
}

# Native curl.exe handles multipart uploads without .NET HttpClient's
# Windows PowerShell 5.1 TLS/proxy behavior. Avoid the PowerShell curl alias.
$Curl = $null
if ($EnableCatbox) {
    $curlCommand = Get-Command "curl.exe" -ErrorAction SilentlyContinue
    if (-not $curlCommand) {
        throw "CATBOX_UPLOAD=YES requires curl.exe. It is included in Windows 10/11; install curl or set CATBOX_UPLOAD=NO."
    }
    $Curl = $curlCommand.Source
}

function Get-VideoInfo {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $json = & $FFprobe `
        "-v" "error" `
        "-select_streams" "v:0" `
        "-show_entries" "stream=width,height,avg_frame_rate:format=duration" `
        "-of" "json" `
        $Path

    if ($LASTEXITCODE -ne 0 -or -not $json) {
        throw "FFprobe could not read video information."
    }

    try {
        $probe = $json | ConvertFrom-Json
    }
    catch {
        throw "Could not parse FFprobe output."
    }

    if (-not $probe.format.duration) {
        throw "Could not determine video duration."
    }

    $duration = [double]::Parse(
        $probe.format.duration.ToString(),
        [System.Globalization.CultureInfo]::InvariantCulture
    )

    if ($duration -le 0) {
        throw "Video duration is invalid."
    }

    if (-not $probe.streams -or $probe.streams.Count -lt 1) {
        throw "The source has no readable video stream."
    }

    $stream = $probe.streams[0]
    $width = [int]$stream.width
    $height = [int]$stream.height
    $fps = 30.0

    if ($stream.avg_frame_rate) {
        $parts = $stream.avg_frame_rate.ToString().Split("/")

        if ($parts.Count -eq 2) {
            $numerator = [double]$parts[0]
            $denominator = [double]$parts[1]

            if ($denominator -ne 0) {
                $fps = $numerator / $denominator
            }
        }
    }

    return @{
        Duration = $duration
        Width    = $width
        Height   = $height
        FPS      = $fps
    }
}

function Test-SourceHasAudio {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $streams = & $FFprobe `
        "-v" "error" `
        "-select_streams" "a:0" `
        "-show_entries" "stream=codec_type" `
        "-of" "default=noprint_wrappers=1:nokey=1" `
        $Path

    if ($LASTEXITCODE -ne 0) {
        throw "FFprobe could not inspect the source audio."
    }

    return ($streams -contains "audio")
}

function Get-EncodingProfile {
    param(
        [Parameter(Mandatory = $true)]
        [int]$BitrateKbps
    )

    if ($BitrateKbps -ge 1800) { return @{ MaxSide = 1280; FPS = 30 } }
    if ($BitrateKbps -ge 1200) { return @{ MaxSide = 1080; FPS = 30 } }
    if ($BitrateKbps -ge 850)  { return @{ MaxSide = 960;  FPS = 30 } }
    if ($BitrateKbps -ge 600)  { return @{ MaxSide = 720;  FPS = 30 } }
    if ($BitrateKbps -ge 400)  { return @{ MaxSide = 640;  FPS = 24 } }
    if ($BitrateKbps -ge 275)  { return @{ MaxSide = 540;  FPS = 24 } }
    if ($BitrateKbps -ge 190)  { return @{ MaxSide = 480;  FPS = 20 } }
    if ($BitrateKbps -ge 120)  { return @{ MaxSide = 360;  FPS = 18 } }
    if ($BitrateKbps -ge 75)   { return @{ MaxSide = 288;  FPS = 15 } }
    if ($BitrateKbps -ge 40)   { return @{ MaxSide = 240;  FPS = 12 } }
    if ($BitrateKbps -ge 20)   { return @{ MaxSide = 180;  FPS = 10 } }

    return @{ MaxSide = 128; FPS = 6 }
}

function Test-OutputWebM {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return $false
    }

    $file = Get-Item -LiteralPath $Path

    if ($file.Length -le 0) {
        return $false
    }

    if ($file.Length -ge $HardMaxBytes) {
        return $false
    }

    $json = & $FFprobe `
        "-v" "error" `
        "-show_entries" "stream=codec_type,codec_name,pix_fmt:format=format_name,duration,size" `
        "-of" "json" `
        $Path

    if ($LASTEXITCODE -ne 0 -or -not $json) {
        return $false
    }

    try {
        $probe = $json | ConvertFrom-Json
    }
    catch {
        return $false
    }

    if ($probe.format.format_name -notmatch "webm") {
        return $false
    }

    $videoStreams = @(
        $probe.streams |
        Where-Object { $_.codec_type -eq "video" }
    )

    $audioStreams = @(
        $probe.streams |
        Where-Object { $_.codec_type -eq "audio" }
    )

    if ($videoStreams.Count -ne 1) {
        return $false
    }

    if ($videoStreams[0].codec_name -ne "vp9") {
        return $false
    }

    if ($videoStreams[0].pix_fmt -notmatch "yuv420p") {
        return $false
    }

    if ($audioStreams.Count -ne 0) {
        return $false
    }

    return $true
}

function Export-MP3 {
    param(
        [Parameter(Mandatory = $true)]
        [string]$InputPath,
        [Parameter(Mandatory = $true)]
        [string]$OutputPath
    )

    # Transcode the first audio stream into a standalone stereo MP3.
    & $FFmpeg `
        "-hide_banner" "-loglevel" "error" `
        "-y" `
        "-i" $InputPath `
        "-map" "0:a:0" `
        "-vn" "-sn" "-dn" `
        "-c:a" "libmp3lame" `
        "-b:a" "${AudioBitrateKbps}k" `
        "-ac" "2" `
        "-map_metadata" "-1" `
        "-f" "mp3" `
        $OutputPath

    if ($LASTEXITCODE -ne 0) {
        throw "FFmpeg MP3 extraction failed."
    }

    if (-not (Test-Path -LiteralPath $OutputPath)) {
        throw "FFmpeg did not produce an MP3 file."
    }

    if ((Get-Item -LiteralPath $OutputPath).Length -le 0) {
        throw "The extracted MP3 is empty."
    }

    $codec = & $FFprobe `
        "-v" "error" `
        "-select_streams" "a:0" `
        "-show_entries" "stream=codec_name" `
        "-of" "default=noprint_wrappers=1:nokey=1" `
        $OutputPath

    if ($LASTEXITCODE -ne 0 -or $codec -notcontains "mp3") {
        throw "MP3 verification failed."
    }
}

function Upload-MP3ToCatbox {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    # Use the Catbox-documented curl multipart API. curl.exe gives much
    # more useful error messages than HttpClient's generic SendAsync errors.
    $ResponsePath = Join-Path $env:TEMP (
        "4chan_catbox_response_" + [guid]::NewGuid().ToString("N") + ".txt"
    )
    $ErrorPath = Join-Path $env:TEMP (
        "4chan_catbox_error_" + [guid]::NewGuid().ToString("N") + ".txt"
    )

    try {
        $curlArgs = @(
            "--silent"
            "--show-error"
            "--http1.1"
            "--connect-timeout", "30"
            "--max-time", "600"
            "--output", $ResponsePath
            "--stderr", $ErrorPath
            "--write-out", "%{http_code}"
            "--form-string", "reqtype=fileupload"
        )

        if (-not [string]::IsNullOrWhiteSpace($CatboxUserHash)) {
            $curlArgs += @("--form-string", "userhash=$CatboxUserHash")
        }

        # PowerShell passes this as a single argument even if Path has spaces.
        # Avoid embedded double quotes, which Windows PowerShell 5.1 may strip.
        $fileForm = 'fileToUpload=@{0};type=audio/mpeg' -f $Path
        $curlArgs += @("--form", $fileForm, $CatboxApiUrl)

        # curl may return no stdout if the connection fails. String
        # interpolation always gives us a non-null string before Trim().
        $httpCodeOutput = & $Curl @curlArgs
        $curlExitCode = $LASTEXITCODE
        $httpCode = "$httpCodeOutput".Trim()

        # CRITICAL: curl --stderr creates this file even on success. When
        # it is empty, Get-Content -Raw can return $null in Windows
        # PowerShell 5.1, causing a null-method error on .Trim(). .NET's
        # ReadAllText returns a non-null empty string instead.
        $curlError = ""
        if ([System.IO.File]::Exists($ErrorPath)) {
            $curlError = [System.IO.File]::ReadAllText($ErrorPath).Trim()
        }

        if ($curlExitCode -ne 0) {
            if ([string]::IsNullOrWhiteSpace($curlError)) {
                $curlError = "curl did not provide further details. Check DNS, HTTPS access, proxy, firewall, or TLS settings."
            }
            if ([string]::IsNullOrWhiteSpace($httpCode)) {
                $httpCode = "none"
            }
            throw "Catbox upload failed (curl exit $curlExitCode, HTTP $httpCode): $curlError"
        }

        if (-not (Test-Path -LiteralPath $ResponsePath)) {
            throw "Catbox upload returned no response body (HTTP $httpCode)."
        }

        # This also handles a zero-byte response file without invoking
        # Trim() on $null.
        $result = [System.IO.File]::ReadAllText($ResponsePath).Trim()

        if ($httpCode -notmatch '^[0-9]{3}$') {
            throw "Catbox upload did not return a valid HTTP status: $httpCode"
        }

        if ([int]$httpCode -lt 200 -or [int]$httpCode -ge 300) {
            if ($result.Length -gt 500) {
                $result = $result.Substring(0, 500) + "..."
            }
            throw "Catbox returned HTTP ${httpCode}: $result"
        }

        if ([string]::IsNullOrWhiteSpace($result)) {
            throw "Catbox returned an empty upload response (HTTP $httpCode)."
        }

        $parsedUrl = $null
        if (-not [Uri]::TryCreate($result, [UriKind]::Absolute, [ref]$parsedUrl)) {
            throw "Catbox returned an invalid URL: $result"
        }

        if (
            $parsedUrl.Scheme -ne "https" -or
            $parsedUrl.Host -ne "files.catbox.moe" -or
            -not $parsedUrl.AbsolutePath.EndsWith(".mp3", [StringComparison]::OrdinalIgnoreCase) -or
            $parsedUrl.Query -ne "" -or
            $parsedUrl.Fragment -ne "" -or
            $parsedUrl.UserInfo -ne ""
        ) {
            throw "Catbox did not return an expected direct MP3 link: $result"
        }

        return $result
    }
    finally {
        Remove-Item -LiteralPath $ResponsePath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $ErrorPath -Force -ErrorAction SilentlyContinue
    }
}

function Get-EncodedWebMPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CatboxUrl
    )

    # Base64url is reversible Base64 using only Windows-safe characters.
    # + becomes -, / becomes _, and trailing = padding is removed.
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($CatboxUrl)
    $filename = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')

    if ($filename.Length -gt 200) {
        throw "Encoded Catbox link exceeds the safe filename length."
    }

    return (Join-Path $OutputDir ($filename + ".webm"))
}

function Convert-To4ChanWebM {
    param(
        [Parameter(Mandatory = $true)]
        [System.IO.FileInfo]$InputFile
    )

    Write-Host ""
    Write-Host "============================================================"
    Write-Host "INPUT" -ForegroundColor Cyan
    Write-Host $InputFile.FullName
    Write-Host "============================================================"

    $TempOutput = Join-Path `
        $OutputDir `
        ("._encoding_" + [guid]::NewGuid().ToString("N") + ".webm")

    $TempAudio = Join-Path `
        $env:TEMP `
        ("4chan_audio_" + [guid]::NewGuid().ToString("N") + ".mp3")

    $PassLog = Join-Path `
        $env:TEMP `
        ("4chan_vp9_" + [guid]::NewGuid().ToString("N"))

    $WorkingTargetBytes = [double]$TargetBytes
    $success = $false
    $FinalOutput = $null
    $FinalCreated = $false
    $CatboxUrl = $null

    try {
        $videoInfo = Get-VideoInfo -Path $InputFile.FullName
        $duration = $videoInfo.Duration
        $sourceFPS = $videoInfo.FPS

        Write-Host ("Duration : {0:N2} seconds" -f $duration)
        Write-Host (
            "Source   : {0}x{1} @ {2:N2} FPS" -f `
            $videoInfo.Width,
            $videoInfo.Height,
            $sourceFPS
        )

        if ($EnableCatbox -and -not (Test-SourceHasAudio -Path $InputFile.FullName)) {
            throw "Source MP4 has no audio stream. Cannot create a Catbox MP3 link."
        }

        for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
            if (Test-Path -LiteralPath $TempOutput) {
                Remove-Item -LiteralPath $TempOutput -Force
            }

            $bitrateBps = (($WorkingTargetBytes * 8.0) / $duration) * 0.93
            $bitrateKbps = [int][Math]::Floor($bitrateBps / 1000.0)

            if ($bitrateKbps -lt 2) {
                $bitrateKbps = 2
            }

            $profile = Get-EncodingProfile -BitrateKbps $bitrateKbps
            $MaxSide = $profile.MaxSide
            $TargetFPS = $profile.FPS

            if ($sourceFPS -lt $TargetFPS) {
                $TargetFPS = [Math]::Max(
                    1,
                    [Math]::Floor($sourceFPS)
                )
            }

            Write-Host ""
            Write-Host ("Attempt {0}/{1}" -f $attempt, $MaxAttempts) -ForegroundColor Yellow
            Write-Host "Video bitrate : $bitrateKbps kbps"
            Write-Host "Max dimension : $MaxSide px"
            Write-Host "Frame rate    : $TargetFPS FPS"

            $VideoFilter = `
                "scale='min(iw,$MaxSide)':'min(ih,$MaxSide)':" +
                "force_original_aspect_ratio=decrease:" +
                "force_divisible_by=2:" +
                "flags=lanczos," +
                "fps=$TargetFPS," +
                "setsar=1"

            $CommonArgs = @(
                "-hide_banner"
                "-loglevel", "error"
                "-y"
                "-i", $InputFile.FullName
                "-map", "0:v:0"
                "-vf", $VideoFilter
                "-c:v", "libvpx-vp9"
                "-b:v", "${bitrateKbps}k"
                "-deadline", "good"
                "-cpu-used", "3"
                "-row-mt", "1"
                "-threads", "0"
                "-pix_fmt", "yuv420p"
                "-an"
                "-sn"
                "-dn"
                "-map_metadata", "-1"
            )

            Write-Host "Pass 1..."

            & $FFmpeg `
                @CommonArgs `
                "-pass", "1" `
                "-passlogfile", $PassLog `
                "-f", "null" `
                "NUL"

            if ($LASTEXITCODE -ne 0) {
                throw "FFmpeg first pass failed."
            }

            Write-Host "Pass 2..."

            & $FFmpeg `
                @CommonArgs `
                "-pass", "2" `
                "-passlogfile", $PassLog `
                "-f", "webm" `
                $TempOutput

            if ($LASTEXITCODE -ne 0) {
                throw "FFmpeg second pass failed."
            }

            if (-not (Test-Path -LiteralPath $TempOutput)) {
                throw "FFmpeg did not create an output file."
            }

            $ActualBytes = (Get-Item -LiteralPath $TempOutput).Length
            $ActualMB = $ActualBytes / 1000000.0

            Write-Host ("Result size     : {0:N3} MB" -f $ActualMB)

            if (
                $ActualBytes -lt $HardMaxBytes -and
                (Test-OutputWebM -Path $TempOutput)
            ) {
                $success = $true
                break
            }

            Write-Host "Still too large or verification failed." -ForegroundColor DarkYellow

            if ($ActualBytes -gt 0) {
                $ratio = $TargetBytes / [double]$ActualBytes
                $WorkingTargetBytes = $WorkingTargetBytes * $ratio * 0.90
            }
            else {
                $WorkingTargetBytes *= 0.75
            }
        }

        if (-not $success) {
            throw "Could not create a valid WebM below 4 MB after $MaxAttempts attempts."
        }

        if ($EnableCatbox) {
            Write-Host ""
            Write-Host ("Extracting audio as {0} kbps MP3..." -f $AudioBitrateKbps) -ForegroundColor Cyan
            Export-MP3 -InputPath $InputFile.FullName -OutputPath $TempAudio
            Write-Host ("MP3 size: {0:N3} MB" -f ((Get-Item -LiteralPath $TempAudio).Length / 1000000.0))

            Write-Host "Uploading MP3 to Catbox..." -ForegroundColor Cyan
            $CatboxUrl = Upload-MP3ToCatbox -Path $TempAudio
            Write-Host "Catbox audio URL: $CatboxUrl" -ForegroundColor Green

            $FinalOutput = Get-EncodedWebMPath -CatboxUrl $CatboxUrl
        }
        else {
            Write-Host "Catbox disabled. Skipping MP3 extraction and upload." -ForegroundColor Cyan
            $FinalOutput = Get-RandomOutputPath
        }

        if (Test-Path -LiteralPath $FinalOutput) {
            throw "Destination WebM already exists: $FinalOutput"
        }

        Move-Item -LiteralPath $TempOutput -Destination $FinalOutput -ErrorAction Stop
        $FinalCreated = $true

        if (-not (Test-OutputWebM -Path $FinalOutput)) {
            throw "Final WebM verification failed."
        }

        $FinalFile = Get-Item -LiteralPath $FinalOutput
        $FinalMB = $FinalFile.Length / 1000000.0

        Write-Host ""
        Write-Host "SUCCESS" -ForegroundColor Green
        Write-Host "Output:"
        Write-Host $FinalOutput -ForegroundColor Green
        Write-Host ("Size: {0:N3} MB" -f $FinalMB)
        if ($EnableCatbox) {
            Write-Host ("Audio: {0}" -f $CatboxUrl)
        }

        if ($DeleteSource) {
            try {
                Remove-Item -LiteralPath $InputFile.FullName -Force -ErrorAction Stop
                Write-Host "Original MP4 deleted." -ForegroundColor Green
            }
            catch {
                Write-Host ("WARNING: WebM and MP3 upload succeeded, but could not delete original MP4: {0}" -f $_.Exception.Message) -ForegroundColor Yellow
            }
        }
        else {
            Write-Host "Original MP4 kept because DELETE_SOURCE=NO." -ForegroundColor Green
        }
    }
    catch {
        Write-Host ""
        Write-Host "FAILED" -ForegroundColor Red
        Write-Host $InputFile.FullName
        Write-Host $_.Exception.Message -ForegroundColor Red

        # Show the actual script location, rather than only the exception
        # message. This also reveals any remaining unexpected null access.
        if ($_.InvocationInfo -and $_.InvocationInfo.ScriptLineNumber -gt 0) {
            Write-Host (
                "Script error at line {0}: {1}" -f `
                $_.InvocationInfo.ScriptLineNumber,
                ([string]$_.InvocationInfo.Line).Trim()
            ) -ForegroundColor DarkYellow
        }
        if ($_.ScriptStackTrace) {
            Write-Host "Call stack:" -ForegroundColor DarkYellow
            Write-Host $_.ScriptStackTrace -ForegroundColor DarkYellow
        }

        Write-Host "Original MP4 was NOT deleted." -ForegroundColor Yellow

        if ($CatboxUrl) {
            Write-Host "NOTE: The MP3 was uploaded before this failure and remains on Catbox:" -ForegroundColor Yellow
            Write-Host $CatboxUrl -ForegroundColor Yellow
        }

        if ($FinalCreated -and $FinalOutput -and (Test-Path -LiteralPath $FinalOutput)) {
            # Only remove a newly moved output if verification failed.
            if (-not (Test-OutputWebM -Path $FinalOutput)) {
                Remove-Item -LiteralPath $FinalOutput -Force -ErrorAction SilentlyContinue
            }
        }
    }
    finally {
        if (Test-Path -LiteralPath $TempOutput) {
            Remove-Item -LiteralPath $TempOutput -Force -ErrorAction SilentlyContinue
        }

        if (Test-Path -LiteralPath $TempAudio) {
            Remove-Item -LiteralPath $TempAudio -Force -ErrorAction SilentlyContinue
        }

        Remove-Item `
            -Path ($PassLog + "*") `
            -Force `
            -ErrorAction SilentlyContinue
    }
}

$Files = @(
    Get-ChildItem `
        -LiteralPath $InputDir `
        -File `
        -Recurse |
    Where-Object {
        $_.Extension -ieq ".mp4"
    }
)

if ($Files.Count -eq 0) {
    Write-Host ""
    Write-Host "No MP4 files found."
    Write-Host ""
    Write-Host $InputDir
    Write-Host ""
    exit 0
}

Write-Host ""
Write-Host ("Found {0} MP4 file(s)." -f $Files.Count) -ForegroundColor Cyan

$current = 0

foreach ($File in $Files) {
    $current++

    Write-Host ""
    Write-Host ("[{0}/{1}]" -f $current, $Files.Count) -ForegroundColor Magenta

    Convert-To4ChanWebM -InputFile $File
}

Write-Host ""
Write-Host "============================================================"
Write-Host "FINISHED" -ForegroundColor Green
Write-Host "============================================================"
Write-Host ""
