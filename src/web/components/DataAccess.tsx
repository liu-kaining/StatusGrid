import type { Manifest } from '../../shared/contracts.js';

export function DataAccess({ manifest, provider }: { manifest?: Manifest | null; provider?: string }) {
  const links = provider ? [
    ['Provider JSON', manifest?.paths.providers[provider]],
    ['Provider RSS', `/feed/provider/${provider}.xml`],
  ] : [['Snapshot JSON', manifest?.paths.summary], ['Manifest', '/api/v1/manifest.json'], ['RSS', '/feed/all.xml'], ['Atom', '/feed/atom.xml'],
    ['Collector Health', manifest?.paths.health]];
  return <section className="data-access" id={provider ? undefined : 'data-access'} aria-label={provider ? '厂商开放数据' : '开放数据'}>
    <div><span className="eyebrow">OPEN DATA</span><p>{provider ? '此厂商的数据订阅' : '公开、可验证、可订阅。'}<small>JSON / RSS / ATOM · UTC</small></p></div>
    <div className="data-links">{links.map(([name, path]) => path && <a key={name} href={path} target="_blank" rel="noopener noreferrer">{name} ↗</a>)}</div>
  </section>;
}
