import { describe, expect, it } from 'vitest'
import { apkUrl, isNewer, latestRelease, notesBetween, parseChanges } from '../src/release-notes.ts'
import { checkReleases } from '../src/updates.ts'

const release = (version: string, extra: Record<string, unknown> = {}) => ({
  tag_name: `v${version}`,
  html_url: `https://github.com/deanbirnie/family-hub/releases/tag/v${version}`,
  body: `## What's Changed\n* Thing in ${version} by @someone in https://github.com/x/y/pull/1\n\n**Full Changelog**: …`,
  assets: [{ name: `family-hub-${version}.apk`, browser_download_url: `https://github.com/deanbirnie/family-hub/releases/download/v${version}/family-hub-${version}.apk` }],
  ...extra,
})

const respond = (data: unknown, status = 200) => (async () => new Response(JSON.stringify(data), { status })) as typeof fetch

describe('release notes', () => {
  it('compares versions, treating development builds as oldest', () => {
    expect(isNewer('0.2.0', '0.1.9')).toBe(true)
    expect(isNewer('0.10.0', '0.9.0')).toBe(true)
    expect(isNewer('0.1.0', '0.1.0')).toBe(false)
    expect(isNewer('0.1.0', 'dev')).toBe(true)
    expect(isNewer('1.0.0-beta.1', '0.1.0')).toBe(false)
  })

  it('skips drafts and pre-releases', () => {
    const r = latestRelease([release('0.3.0', { draft: true }), release('0.4.0', { prerelease: true }), release('0.2.0')])
    expect(r?.tag_name).toBe('v0.2.0')
  })

  it('reads the changes, newest first, without author and link', () => {
    expect(parseChanges(release('1.0.0').body)).toEqual(['Thing in 1.0.0'])
    const notes = notesBetween([release('0.2.0'), release('0.4.0'), release('0.3.0'), release('0.1.0')], '0.1.0', '0.4.0')
    expect(notes.map((n) => n.version)).toEqual(['0.4.0', '0.3.0', '0.2.0'])
  })

  it('only accepts an APK from the project’s own releases', () => {
    expect(apkUrl(release('0.2.0'))).toMatch(/^https:\/\/github\.com\/deanbirnie\/family-hub\/releases\/download\//)
    expect(apkUrl(release('0.2.0', { assets: [{ name: 'family-hub-0.2.0.apk', browser_download_url: 'https://evil.example/app.apk' }] }))).toBeUndefined()
  })
})

describe('update check', () => {
  it('offers a newer release that has an APK', async () => {
    const r = await checkReleases('0.1.0', respond([release('0.2.0'), release('0.1.0')]))
    expect(r).toMatchObject({ status: 'available', version: '0.2.0' })
    expect(r.notes?.[0]?.changes).toEqual(['Thing in 0.2.0'])
  })

  it('says current when nothing newer, or the newer release has no APK', async () => {
    expect((await checkReleases('0.2.0', respond([release('0.2.0')]))).status).toBe('current')
    expect((await checkReleases('0.1.0', respond([release('0.2.0', { assets: [] })]))).status).toBe('current')
  })

  it('reports a failure in words', async () => {
    const r = await checkReleases('0.1.0', respond({ message: 'rate limited' }, 403))
    expect(r).toMatchObject({ status: 'error' })
    expect(r.message).toMatch(/403/)
  })
})
