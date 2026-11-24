const el = (tag, text, className) => {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  if (className) node.className = className
  return node
}
function link(text, url, className) {
  const node = el('a', text, className)
  node.href = url
  return node
}
const platforms = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }
function releaseCard(release) {
  const card = el('article', undefined, 'release')
  const info = el('div', undefined, 'release-top')
  info.append(el('h3', 'v' + release.version), el('span', release.date, 'meta'))
  card.append(info)
  for (const file of release.files.filter((file) => file.platform !== 'src')) {
    const row = el('div', undefined, 'file-row')
    const desc = el('div')
    const title = platforms[file.platform] + (file.arch ? ' · ' + file.arch : '') + ' · ' + file.format
    desc.append(
      el('strong', title),
      el('span', file.format + '  /  ' + (file.size / 1048576).toFixed(1) + ' MiB', 'meta'),
    )
    const details = el('details')
    details.append(
      el('summary', '下载说明与 SHA-256 校验'),
      el('code', file.sha256),
      link('校验文件', file.checksumUrl, 'digest-link'),
    )
    if (file.backupUrl) {
      details.append(link('七牛备用下载', file.backupUrl, 'digest-link'))
    }
    desc.append(details)
    const anchor = link('下载', file.url, 'button')
    anchor.setAttribute('aria-label', '下载 ' + release.version + ' ' + title)
    row.append(desc, anchor)
    card.append(row)
  }
  return card
}
const latest = document.querySelector('#latest')
try {
  const response = await fetch('./data/releases.json', { cache: 'no-store' })
  if (!response.ok) throw Error('HTTP ' + response.status)
  const data = await response.json()
  const footer = document.querySelector('#footer-info')
  footer.append(el('span', '网站 ' + data.siteVersion), link(data.icp, 'https://beian.miit.gov.cn/'))
  const first = data.releases.find((release) => release.version === data.latestVersion)
  const features = document.querySelector('[data-feature-version]')
  if (first && features?.dataset.featureVersion === first.version) {
    features.querySelector('.feature-version').textContent = 'v' + first.version
    features.hidden = false
  }
  const previous = data.releases.filter((release) => release.version !== data.latestVersion)
  latest.replaceChildren(first ? releaseCard(first) : el('p', '暂无已发布版本。', 'empty'))
  if (previous.length && document.querySelector('#history')) {
    document.querySelector('#previous').replaceChildren(...previous.map(releaseCard))
    document.querySelector('#history').hidden = false
  }
} catch {
  latest.replaceChildren(
    el('p', '发行清单暂时无法读取。', 'empty'),
    link('重新加载', location.href, 'text-link'),
  )
}
