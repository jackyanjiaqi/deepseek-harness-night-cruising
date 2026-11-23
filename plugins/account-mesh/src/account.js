/**
 * Reads the signed-in DeepSeek account identity through the Host service.
 *
 * Only the account and device identifiers leave this module: the platform
 * token is read by `getPlatformSession()` but is deliberately never copied,
 * logged, or persisted by the mesh.
 *
 * `getPlatformSession().userId` is populated from the account service's last
 * successful profile read, so a freshly booted Host may know the token but not
 * the account id. When that happens this module performs one profile read (at
 * most once a minute) so the mesh can still tag the account; without a network
 * the account stays unresolved and the plugin reports that instead of guessing.
 */
import { accountTagOf } from './identity.js'

const PROFILE_RETRY_MS = 60_000
let lastProfileAttempt = 0

function clientMetadata(version) {
  return {
    version: version ?? '0.0.0',
    locale: 'zh',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
}

async function profileUserId(account, version) {
  if (Date.now() - lastProfileAttempt < PROFILE_RETRY_MS) return undefined
  lastProfileAttempt = Date.now()
  try {
    const profile = await account.getProfile(clientMetadata(version))
    if (profile?.status === 'ready') return profile.value?.id ?? undefined
  } catch {
    // Offline or refused: the account stays unresolved until the next attempt.
  }
  return undefined
}

/** Snapshot of the account facts the mesh needs. */
export async function readAccount(ctx, { version } = {}) {
  const account = ctx.get('deepseekAccount')
  if (!account) return { status: 'unavailable', reason: 'deepseekAccount service is not mounted' }
  let session
  try {
    session = await account.getPlatformSession()
  } catch {
    session = undefined
  }
  let device
  try {
    device = await account.getDeviceIdentity()
  } catch {
    device = undefined
  }
  let userId = session?.userId ?? device?.userId ?? undefined
  if (!userId) {
    userId = await profileUserId(account, version)
    if (userId) {
      try {
        session = (await account.getPlatformSession()) ?? session
      } catch {
        // keep the previous snapshot
      }
    }
  }
  const deviceId = device?.deviceId ?? undefined
  if (!userId) {
    return {
      status: session ? 'pending' : 'signed-out',
      deviceId,
      reason: session ? 'signed in, account id not resolved yet' : 'no stored account credential',
    }
  }
  return {
    status: 'ready',
    userId,
    deviceId,
    accountTag: accountTagOf(userId),
    origin: session?.origin,
  }
}
