$ErrorActionPreference = 'Stop'

$targetAddress = '192.168.32.61'
$dnsServers = @('223.5.5.5', '114.114.114.114')

$ipEntry = Get-NetIPAddress -AddressFamily IPv4 -IPAddress $targetAddress -ErrorAction Stop |
    Select-Object -First 1

if (-not $ipEntry) {
    throw "No network adapter currently owns $targetAddress. DNS was not changed."
}

Set-DnsClientServerAddress `
    -InterfaceIndex $ipEntry.InterfaceIndex `
    -ServerAddresses $dnsServers

Clear-DnsClientCache

$result = Get-DnsClientServerAddress `
    -InterfaceIndex $ipEntry.InterfaceIndex `
    -AddressFamily IPv4

Write-Host "DNS updated on interface $($ipEntry.InterfaceAlias) (index $($ipEntry.InterfaceIndex))."
Write-Host "DNS servers: $($result.ServerAddresses -join ', ')"
