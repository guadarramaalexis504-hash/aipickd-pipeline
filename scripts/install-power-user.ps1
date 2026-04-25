#Requires -Version 5.1
# AIPickd Power-User Installer
# Installs: Playwright + Nodemailer + Ollama + Llama 3.3 8B
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install-power-user.ps1
#   powershell -ExecutionPolicy Bypass -File install-power-user.ps1 -Full
#   powershell -ExecutionPolicy Bypass -File install-power-user.ps1 -LightOnly

param(
  [switch]$Full,
  [switch]$LightOnly,
  [switch]$SkipOllama
)

$ErrorActionPreference = "Stop"
$NegocioRoot = "C:\Users\guada\Downloads\Negocio"

function Step($num, $msg) {
  Write-Host ""
  Write-Host "============================================================" -ForegroundColor Cyan
  Write-Host "  STEP $num - $msg" -ForegroundColor Cyan
  Write-Host "============================================================" -ForegroundColor Cyan
}

function CheckCommand($cmd) {
  return [bool](Get-Command $cmd -ErrorAction SilentlyContinue)
}

Set-Location $NegocioRoot
Write-Host ">> AIPickd Power-User Installer" -ForegroundColor Green
Write-Host "   Directory: $NegocioRoot"
Write-Host ""

# ------------------------------------------------------------
# STEP 1 - Playwright
# ------------------------------------------------------------
Step 1 "Installing Playwright (browser automation)"

if (-not (Test-Path ".\node_modules\playwright")) {
  Write-Host "Installing playwright npm package..."
  npm install playwright --save
  Write-Host "Downloading Chromium browser (approx 170MB)..."
  npx playwright install chromium
  Write-Host "[OK] Playwright installed." -ForegroundColor Green
} else {
  Write-Host "[SKIP] Playwright already installed."
}

# ------------------------------------------------------------
# STEP 2 - Nodemailer
# ------------------------------------------------------------
Step 2 "Installing Nodemailer (email digest)"
if (-not (Test-Path ".\node_modules\nodemailer")) {
  npm install nodemailer --save
  Write-Host "[OK] Nodemailer installed." -ForegroundColor Green
} else {
  Write-Host "[SKIP] Nodemailer already installed."
}

if ($LightOnly) {
  Write-Host ""
  Write-Host "[DONE] LIGHT install complete." -ForegroundColor Green
  Write-Host "       Re-run without -LightOnly for Ollama + models."
  exit 0
}

# ------------------------------------------------------------
# STEP 3 - Ollama
# ------------------------------------------------------------
if (-not $SkipOllama) {
  Step 3 "Installing Ollama (run LLMs locally - free alternative to OpenAI)"

  if (CheckCommand "ollama") {
    Write-Host "[SKIP] Ollama already installed."
  } else {
    Write-Host "Installing Ollama..."
    $installedViaWinget = $false
    try {
      winget install --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements
      $installedViaWinget = $true
      Write-Host "[OK] Ollama installed via winget." -ForegroundColor Green
    } catch {
      Write-Host "[WARN] winget failed, downloading installer manually..." -ForegroundColor Yellow
    }
    if (-not $installedViaWinget) {
      $installer = "$env:TEMP\OllamaSetup.exe"
      Write-Host "Downloading from https://ollama.com/download/OllamaSetup.exe ..."
      Invoke-WebRequest -Uri "https://ollama.com/download/OllamaSetup.exe" -OutFile $installer
      Write-Host "Running installer (silent)..."
      Start-Process -FilePath $installer -ArgumentList "/S" -Wait
      Write-Host "[OK] Ollama installer finished." -ForegroundColor Green
    }
    # Refresh PATH for this session
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
  }

  # Wait a moment for Ollama service to be ready
  Start-Sleep -Seconds 3

  # Step 4 - Pull Llama 3.3 8B
  Step 4 "Pulling Llama 3.3 8B model (approx 4.7GB download)"
  Write-Host "This may take 5-10 minutes depending on your internet."
  & ollama pull llama3.3:8b

  # Test
  Write-Host ""
  Write-Host "Testing Llama..." -ForegroundColor Yellow
  & ollama run llama3.3:8b "Say hello in 5 words or less."

  Write-Host ""
  Write-Host "[OK] Ollama + Llama 3.3 8B ready." -ForegroundColor Green
  Write-Host "     CLI: ollama run llama3.3:8b"
  Write-Host "     API: http://localhost:11434/api/generate"

  # Big model - only if Full flag
  if ($Full) {
    Step 5 "Pulling Llama 3.3 70B model (approx 40GB - needs 48GB+ RAM)"
    Write-Host "[WARN] This download is HUGE and needs a lot of RAM to run." -ForegroundColor Yellow
    $confirm = Read-Host "Continue? (y/N)"
    if ($confirm -eq "y" -or $confirm -eq "Y") {
      & ollama pull llama3.3:70b
      Write-Host "[OK] Llama 3.3 70B ready."
    } else {
      Write-Host "[SKIP] Skipped 70B model."
    }
  }
}

# ------------------------------------------------------------
# STEP 6 - Stable Diffusion WebUI (only if -Full)
# ------------------------------------------------------------
if ($Full) {
  Step 6 "Installing Stable Diffusion WebUI"

  if (-not (CheckCommand "python")) {
    Write-Host "[ERROR] Python not found. Install Python 3.10.x from https://python.org/downloads/" -ForegroundColor Red
    Write-Host "        After installing Python, re-run with -Full"
  } elseif (-not (CheckCommand "git")) {
    Write-Host "[ERROR] git not found. Install from https://git-scm.com/download/win" -ForegroundColor Red
  } else {
    $sdPath = "$NegocioRoot\..\stable-diffusion-webui"
    if (Test-Path $sdPath) {
      Write-Host "[SKIP] Stable Diffusion WebUI already cloned at $sdPath"
    } else {
      Write-Host "Cloning AUTOMATIC1111/stable-diffusion-webui..."
      git clone https://github.com/AUTOMATIC1111/stable-diffusion-webui.git $sdPath
      Write-Host "[OK] Cloned. First run will download PyTorch + models (approx 10GB)." -ForegroundColor Green
      Write-Host "     To start: cd $sdPath; .\webui-user.bat"
    }
  }
} else {
  Write-Host ""
  Write-Host "[INFO] Skipped Stable Diffusion WebUI. Use -Full to install." -ForegroundColor DarkGray
}

# ------------------------------------------------------------
# Final summary
# ------------------------------------------------------------
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  [DONE] POWER-USER INSTALL COMPLETE" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Installed:"
Write-Host "  * Playwright + Chromium (monitoring, scraping)"
Write-Host "  * Nodemailer (email digest)"
if (-not $SkipOllama) {
  Write-Host "  * Ollama + Llama 3.3 8B (local LLMs - free)"
}
if ($Full) {
  Write-Host "  * Stable Diffusion WebUI (if Python + git were present)"
}
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Tell Claude: 'ya instale manito'"
Write-Host "  2. Claude will build scripts that use Playwright + Ollama"
Write-Host ""
