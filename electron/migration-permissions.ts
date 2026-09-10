import { execFile } from "node:child_process";

// Some Windows installations deny Robocopy's security-copy request even when
// the current owner can set the access ACL. Use .NET's access-only APIs in that
// case, then verify every effective access rule. Never downgrade to DAT alone.
export async function copyMigrationPermissions(source: string, destination: string): Promise<void> {
  const script = `
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$sourceRoot = $env:CDRIVESHIFT_ACL_SOURCE
$destinationRoot = $env:CDRIVESHIFT_ACL_DESTINATION
$section = [Security.AccessControl.AccessControlSections]::Access
$identityType = [Security.Principal.SecurityIdentifier]
function Signature($acl) {
  $rows = foreach ($rule in $acl.GetAccessRules($true, $true, $identityType)) {
    '{0}|{1}|{2}|{3}|{4}' -f $rule.IdentityReference.Value, [int64]$rule.FileSystemRights, [int]$rule.AccessControlType, [int]$rule.InheritanceFlags, [int]$rule.PropagationFlags
  }
  return (($rows | Sort-Object) -join ';')
}
$pending = [Collections.Generic.Queue[string]]::new()
$pending.Enqueue('')
while ($pending.Count -gt 0) {
  $relative = $pending.Dequeue()
  $from = if ($relative) { [IO.Path]::Combine($sourceRoot, $relative) } else { $sourceRoot }
  $to = if ($relative) { [IO.Path]::Combine($destinationRoot, $relative) } else { $destinationRoot }
  $attributes = [IO.File]::GetAttributes($from)
  $targetAttributes = [IO.File]::GetAttributes($to)
  if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    if (($targetAttributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) { throw "Link type differs: $relative" }
    continue
  }
  if (($targetAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Destination was replaced by a link: $relative" }
  $directory = ($attributes -band [IO.FileAttributes]::Directory) -ne 0
  if ($directory -ne (($targetAttributes -band [IO.FileAttributes]::Directory) -ne 0)) { throw "Entry type differs: $relative" }
  $acl = if ($directory) { [IO.Directory]::GetAccessControl($from, $section) } else { [IO.File]::GetAccessControl($from, $section) }
  if (-not $acl.AreAccessRulesCanonical) { throw "Noncanonical ACL requires application-native migration: $relative" }
  if (-not $relative) {
    foreach ($rule in $acl.GetAccessRules($false, $true, $identityType)) {
      if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny) { throw "Inherited deny ACL cannot be safely converted: $relative" }
    }
  }
  $expected = Signature $acl
  # Anchor only the root to its original effective grants. Children must retain
  # their original inheritance setting so updater ACL changes still propagate.
  $protected = if ($relative) { $acl.AreAccessRulesProtected } else { $true }
  $acl.SetAccessRuleProtection($protected, $true)
  $acl.SetSecurityDescriptorBinaryForm($acl.GetSecurityDescriptorBinaryForm(), $section)
  if ($directory) { [IO.Directory]::SetAccessControl($to, $acl) } else { [IO.File]::SetAccessControl($to, $acl) }
  $written = if ($directory) { [IO.Directory]::GetAccessControl($to, $section) } else { [IO.File]::GetAccessControl($to, $section) }
  if ((Signature $written) -ne $expected) { throw "Copied access permissions differ: $relative" }
  if ($directory) {
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($from)) {
      $pending.Enqueue([IO.Path]::Combine($relative, [IO.Path]::GetFileName($entry)))
    }
  }
}
`;
  await new Promise<void>((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      windowsHide: true,
      timeout: 24 * 60 * 60_000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, CDRIVESHIFT_ACL_SOURCE: source, CDRIVESHIFT_ACL_DESTINATION: destination }
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`NTFS 权限保留失败，请使用管理员权限或应用自带迁移功能：${(stderr || stdout || error.message).trim().slice(-1600)}`));
      else resolve();
    });
  });
}
