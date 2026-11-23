#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
if (!args.includes('--strict')) {
  console.log('未签名')
} else {
  const targets = args.filter((arg) => arg !== '--strict').map((arg) => resolve(arg))
  try {
    if (!targets.length) throw new Error('请指定要验证的应用或安装包')
    for (const target of targets) {
      if (process.platform === 'darwin') {
        execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', target], { stdio: 'inherit' })
        execFileSync('xcrun', ['stapler', 'validate', target], { stdio: 'inherit' })
      } else if (process.platform === 'win32') {
        const command = '$signature = Get-AuthenticodeSignature -LiteralPath $env:EVO_SIGNATURE_TARGET; ' +
          'if ($signature.Status -ne "Valid") { Write-Error ("Invalid Authenticode signature: " + $signature.Status); exit 1 }'
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
          stdio: 'inherit', env: { ...process.env, EVO_SIGNATURE_TARGET: target }, windowsHide: true
        })
      } else {
        throw new Error('当前平台不支持签名验证')
      }
    }
    console.log('签名验证通过')
  } catch (err) {
    console.error(err.message)
    process.exitCode = 1
  }
}
