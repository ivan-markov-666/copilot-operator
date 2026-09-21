import { findLikelyDamage } from '../src/protocol/parser.js';

const cases: Array<[string, boolean]> = [
  // The real damaged commands seen in the live run
  ["@{Name='FreeSpaceGB';Expression={:Round($_.Free/1GB,2)}}", true],
  ['[pscustomobject]@{FreeSpaceGB=:Round($c.FreeSpace/1GB,2)}', true],
  ["Write-Output ('FreeSpaceGB=' + :Round($c.Free/1GB,2))", true],
  // The three the second rules-engine run lost: rounding was never the only casualty.
  ["ForEach-Object { :Matches((Get-Content $_ -Raw), \"getByTestId\\('([^']+)'\\)\") }", true],
  ['$_ -match "\\|$(:Escape($remote))/"', true],
  ['$lines[($start - 1)..(:Min($start + 24, $lines.Count - 1))]', true],
  // Correct commands that must not be flagged
  ['[math]::Round($c.FreeSpace/1GB,2)', false],
  ['$re = [regex]; $re::Escape($name)', false],
  // git's own `%(refname:short)` is a colon inside a format string, not an eaten type.
  ["git for-each-ref --format='%(refname:short)|%(upstream:track)' refs/heads", false],
  ['Select-String -Pattern $p -AllMatches', false],
  ['[System.Math]::Round($x, 2)', false],
  ['$m = [math]; $m::Round($x, 2)', false],
  ['"{0:N2}" -f $x', false],
  ['(3.14).ToString("N2")', false],
  ['Get-Service | Where-Object Status -eq Running', false],
  ['Get-ChildItem C:\Windows -Filter *.log', false],
  ['Get-Process -Name pwsh -ErrorAction:SilentlyContinue', false],
  ['[pscustomobject]@{Edition=$os.ProductName}', false],
];

let bad = 0;
for (const [cmd, shouldFlag] of cases) {
  const found = findLikelyDamage(cmd) !== null;
  const ok = found === shouldFlag;
  if (!ok) bad += 1;
  console.log(`${ok ? 'ok  ' : 'WRONG'}  flagged=${String(found).padEnd(5)} ${cmd.slice(0, 58)}`);
}
console.log(bad === 0 ? '\nall cases correct' : `\n${bad} case(s) wrong`);
