const DM_BASE = 'https://developer.api.autodesk.com';

export interface FolderItem {
  id: string;
  type: 'folders' | 'items';
  attributes: {
    displayName: string;
    createTime?: string;
    lastModifiedTime?: string;
    extension?: {
      type?: string;
      data?: Record<string, unknown>;
    };
  };
  relationships?: {
    storage?: { data?: { id: string } };
  };
}

export interface VersionAttributes {
  extension?: {
    type?: string;
    data?: {
      revitProjectVersion?: number;
      isCompositeDesign?: boolean;
      compositeParentFile?: string;
    };
  };
  createTime?: string;
  lastModifiedTime?: string;
  storageSize?: number;
}

export async function getTopFolders(
  hubId: string,
  projectId: string,
  token: string
): Promise<FolderItem[]> {
  const res = await fetch(
    `${DM_BASE}/project/v1/hubs/${hubId}/projects/${projectId}/topFolders`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    if (res.status === 403) throw Object.assign(new Error('Forbidden'), { status: 403 });
    throw new Error(`topFolders failed: ${res.status}`);
  }
  const data = await res.json();
  return data.data ?? [];
}

export async function getFolderContents(
  projectId: string,
  folderId: string,
  token: string
): Promise<{ folders: FolderItem[]; items: FolderItem[] }> {
  let offset = 0;
  const limit = 200;
  const folders: FolderItem[] = [];
  const items: FolderItem[] = [];

  while (true) {
    const res = await fetch(
      `${DM_BASE}/data/v1/projects/${projectId}/folders/${folderId}/contents?limit=${limit}&offset=${offset}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) {
      if (res.status === 403) throw Object.assign(new Error('Forbidden'), { status: 403 });
      throw new Error(`folder contents failed: ${res.status}`);
    }
    const data = await res.json();
    const batch: FolderItem[] = data.data ?? [];
    for (const item of batch) {
      if (item.type === 'folders') folders.push(item);
      else if (item.type === 'items') items.push(item);
    }
    if (batch.length < limit) break;
    offset += limit;
  }

  return { folders, items };
}

export async function getItemVersions(
  projectId: string,
  itemId: string,
  token: string
): Promise<VersionAttributes[]> {
  const res = await fetch(
    `${DM_BASE}/data/v1/projects/${projectId}/items/${itemId}/versions?limit=1`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return (data.data ?? []).map((v: { attributes: VersionAttributes }) => v.attributes);
}

export async function listHubs(token: string): Promise<{ id: string; name: string; region: string }[]> {
  const res = await fetch(`${DM_BASE}/project/v1/hubs`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`listHubs failed: ${res.status}`);
  const data = await res.json();
  return (data.data ?? []).map((h: { id: string; attributes: { name: string; region: string } }) => ({
    id: h.id,
    name: h.attributes.name,
    region: h.attributes.region,
  }));
}
