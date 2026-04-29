const DERIV_BASE = 'https://developer.api.autodesk.com/derivativeservice/v2';

export async function getManifestVersion(urn: string, token: string): Promise<string | null> {
  const encodedUrn = Buffer.from(urn).toString('base64').replace(/=/g, '');
  const res = await fetch(`${DERIV_BASE}/manifest/${encodedUrn}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;

  const manifest = await res.json();
  const derivative = manifest.derivatives?.find(
    (d: { outputType: string }) => d.outputType === 'svf' || d.outputType === 'svf2'
  );
  if (!derivative) return null;

  const docInfo = derivative.children?.find(
    (c: { role: string }) => c.role === 'Autodesk.CloudPlatform.DocumentInfo'
  );
  const version = docInfo?.properties?.['Document Information']?.RVTVersion;
  return version != null ? String(version) : null;
}
