import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const nodeDataChannel = require('node-datachannel')

console.log('[p0] node-datachannel loaded')
console.log('[p0] versions', JSON.stringify({ node: process.versions.node, napi: process.versions.napi, electron: process.versions.electron ?? null, arch: process.arch }))

const ndc = nodeDataChannel.default ?? nodeDataChannel
console.log('[p0] module keys', Object.keys(nodeDataChannel).slice(0, 24).join(','))
const t0 = Date.now()
const peer1 = new ndc.PeerConnection('Peer1', { iceServers: [] })
const peer2 = new ndc.PeerConnection('Peer2', { iceServers: [] })

let dc1 = null
peer1.onLocalDescription((sdp, type) => peer2.setRemoteDescription(sdp, type))
peer1.onLocalCandidate((c, mid) => peer2.addRemoteCandidate(c, mid))
peer2.onLocalDescription((sdp, type) => peer1.setRemoteDescription(sdp, type))
peer2.onLocalCandidate((c, mid) => peer1.addRemoteCandidate(c, mid))

peer2.onDataChannel((dc2) => {
  dc2.onMessage((msg) => {
    console.log('[p0] peer2 received:', msg)
    dc2.sendMessage('pong-' + msg)
    setTimeout(() => finish('ok'), 50)
  })
})

dc1 = peer1.createDataChannel('mesh-rpc')
dc1.onOpen(() => {
  console.log('[p0] dc open in', Date.now() - t0, 'ms')
  dc1.sendMessage('ping')
})
dc1.onMessage((msg) => console.log('[p0] peer1 received:', msg))

let done = false
function finish(status) {
  if (done) return
  done = true
  console.log('[p0] RESULT', status, 'elapsed', Date.now() - t0, 'ms')
  try { peer1.close(); peer2.close() } catch {}
  setTimeout(() => process.exit(status === 'ok' ? 0 : 1), 100)
}
setTimeout(() => finish('timeout'), 15000)
