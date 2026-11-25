# Installs the Local Studio helper from a GitHub release, on Windows:
#
#   irm https://github.com/baney75/tychicus/releases/latest/download/install.ps1 | iex
#
# It downloads this computer's archive and SHA256SUMS from the latest release of baney75/tychicus (or the one
# TYCHICUS_VERSION names) into a temporary folder, checks the archive's SHA-256, checks its build attestation when the
# GitHub CLI is on PATH and signed in, unpacks it and runs `tychicus.exe install --release <folder>`, which checks the files again and
# registers the helper with each Chromium browser. It needs no administrator rights and refuses to run elevated.
#
# With options (anything but --allow-root goes to `tychicus install --release`: --local-studio, --force,
# --browser <name>, --dry-run):
#   & ([scriptblock]::Create((irm https://github.com/baney75/tychicus/releases/latest/download/install.ps1))) --local-studio
# Environment:
#   TYCHICUS_VERSION            a release version such as 1.2.3 instead of the latest
#   TYCHICUS_GH                 the GitHub CLI to check attestations with, or "none" to skip that check
#   TYCHICUS_INSTALL_BASE_URL   tests only: a loopback http:// address that stands in for the releases page

function Install-Tychicus {
	param([string[]]$Arguments)
	$ErrorActionPreference = 'Stop'
	$ProgressPreference = 'SilentlyContinue'
	$repo = 'baney75/tychicus'
	$workflow = "$repo/.github/workflows/release.yml"
	$base = "https://github.com/$repo/releases"

	function Fail([string]$message) {
		throw "tychicus install: $message"
	}

	$allowRoot = $false
	$dryRun = $false
	$passOn = @()
	foreach ($arg in $Arguments) {
		if ($arg -eq '--allow-root') { $allowRoot = $true }
		elseif ($arg -eq '--dry-run') { $dryRun = $true; $passOn += $arg }
		else { $passOn += $arg }
	}

	$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
	$elevated = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
	if ($elevated -and -not $allowRoot) {
		Fail 'refusing to run as administrator. The helper installs into your own profile and needs no elevation. Run this from a PowerShell window that is not "Run as administrator", or pass --allow-root.'
	}

	if ($env:TYCHICUS_INSTALL_BASE_URL) {
		if ($env:TYCHICUS_INSTALL_BASE_URL -notmatch '^http://(127\.0\.0\.1|localhost)(:\d+)?(/|$)') {
			Fail "TYCHICUS_INSTALL_BASE_URL is for tests and must be a loopback http:// address; it is $($env:TYCHICUS_INSTALL_BASE_URL)"
		}
		$base = $env:TYCHICUS_INSTALL_BASE_URL.TrimEnd('/')
	} else {
		# Windows PowerShell 5.1 may not offer TLS 1.2 by default; GitHub needs it.
		[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
	}

	$cpu = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
	switch ($cpu) {
		'AMD64' { $arch = 'x64' }
		'ARM64' { $arch = 'arm64' }
		default { Fail "no release is built for $cpu. Releases are built for win-x64: https://github.com/$repo/releases" }
	}
	$tag = "win-$arch"

	$dir = Join-Path ([IO.Path]::GetTempPath()) ("tychicus-install-" + [Guid]::NewGuid().ToString('N').Substring(0, 12))
	New-Item -ItemType Directory -Path $dir | Out-Null
	try {
		$version = "$($env:TYCHICUS_VERSION)".TrimStart('v')
		if ($version) {
			if ($version -notmatch '^\d+\.\d+\.\d+$') { Fail "TYCHICUS_VERSION must be a release version such as 1.2.3; it is $($env:TYCHICUS_VERSION)" }
			$sumsUrl = "$base/download/v$version/SHA256SUMS"
		} else {
			$sumsUrl = "$base/latest/download/SHA256SUMS"
		}

		Write-Host "Downloading SHA256SUMS from $sumsUrl"
		$sumsFile = Join-Path $dir 'SHA256SUMS'
		try { Invoke-WebRequest -UseBasicParsing -Uri $sumsUrl -OutFile $sumsFile } catch { Fail "could not download $sumsUrl. Check the version and your connection. ($($_.Exception.Message))" }

		# The archive name carries the version, so the latest release's SHA256SUMS says which version "latest" is.
		$pattern = "^([0-9a-fA-F]{64})  (tychicus-(\d+\.\d+\.\d+)-$tag\.zip)$"
		$line = Get-Content -LiteralPath $sumsFile | Where-Object { $_ -match $pattern } | Select-Object -First 1
		if (-not $line) { Fail "this release has no archive for $tag. Releases are built for win-x64: https://github.com/$repo/releases" }
		$null = $line -match $pattern
		$want = $Matches[1].ToLowerInvariant()
		$archive = $Matches[2]
		$found = $Matches[3]
		if ($version -and $found -ne $version) { Fail "SHA256SUMS for v$version lists $archive, not version $version." }
		$version = $found

		Write-Host "Downloading $archive"
		$archivePath = Join-Path $dir $archive
		try { Invoke-WebRequest -UseBasicParsing -Uri "$base/download/v$version/$archive" -OutFile $archivePath } catch { Fail "could not download $archive. ($($_.Exception.Message))" }

		$got = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
		if ($got -ne $want) { Fail "the SHA-256 of $archive does not match SHA256SUMS (got $got, want $want). The download is damaged or was changed; nothing was installed." }
		Write-Host "Checked: $archive matches SHA256SUMS"

		$gh = $env:TYCHICUS_GH
		if (-not $gh) {
			$ghCommand = Get-Command gh -ErrorAction SilentlyContinue | Select-Object -First 1
			if ($ghCommand) { $gh = $ghCommand.Source }
		}
		$ghSignedOut = $false
		if ($gh -and $gh -ne 'none') {
			# gh attestation verify needs a token, so a signed-out gh can't check. GH_TOKEN or GITHUB_TOKEN counts as
			# signed in. gh prints on stderr: see the note below about 'Continue'.
			$saved = $ErrorActionPreference
			$ErrorActionPreference = 'Continue'
			try {
				$null = & $gh auth status --hostname github.com 2>&1
				$ghSignedOut = $LASTEXITCODE -ne 0
			} finally {
				$ErrorActionPreference = $saved
			}
		}
		if (-not $gh -or $gh -eq 'none') {
			Write-Host "Skipped the build attestation check: the GitHub CLI (gh) is not installed. With it, this also runs gh attestation verify --repo $repo."
		} elseif ($ghSignedOut) {
			Write-Host "Skipped the build attestation check: the GitHub CLI (gh) is installed but not signed in, so the build attestation was not checked. Run gh auth login to turn the check on."
		} else {
			# gh prints progress on stderr. Under 'Stop', Windows PowerShell 5.1 turns any stderr line from a native
			# program into a terminating error, so run it under 'Continue' and judge it by its exit code alone.
			$saved = $ErrorActionPreference
			$ErrorActionPreference = 'Continue'
			try {
				$out = & $gh attestation verify $archivePath --repo $repo --signer-workflow $workflow 2>&1
				$code = $LASTEXITCODE
			} finally {
				$ErrorActionPreference = $saved
			}
			if ($code -ne 0) {
				$out | Select-Object -Last 5 | ForEach-Object { Write-Host $_ }
				Fail "gh attestation verify refused ${archive}: it was not built by $repo's release workflow, or gh could not check (run gh auth login). Nothing was installed."
			}
			Write-Host "Checked: $archive was built by $repo's release workflow (gh attestation verify)"
		}

		Expand-Archive -LiteralPath $archivePath -DestinationPath $dir
		$program = Join-Path (Join-Path $dir ([IO.Path]::GetFileNameWithoutExtension($archive))) 'tychicus.exe'
		if (-not (Test-Path -LiteralPath $program)) { Fail "$archive holds no tychicus.exe." }

		# The program checks again; after a signed-out gh it must not try what gh just said it can't do. Restore the
		# variable after, since `irm | iex` runs in the caller's own session.
		$savedGh = $env:TYCHICUS_GH
		if ($ghSignedOut) { $env:TYCHICUS_GH = 'none' }
		try {
			& $program install --release $dir @passOn
			$code = $LASTEXITCODE
		} finally {
			$env:TYCHICUS_GH = $savedGh
		}
		if ($code -ne 0) { Fail 'tychicus install --release failed; see above. Nothing changed if it stopped before registering.' }
		if ($dryRun) { return }

		$localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME 'AppData\Local' }
		$root = Join-Path $localAppData 'Tychicus\release'
		Write-Host ''
		Write-Host "The Local Studio helper $version is installed in $root."
		Write-Host 'Next: if you added the extension from the Chrome Web Store, its side panel now shows the helper connected. Otherwise load'
		Write-Host "the extension from the folder printed above. Then connect your coding agents: & '$root\tychicus.exe' setup"
	} finally {
		Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
	}
}

Install-Tychicus -Arguments $args
