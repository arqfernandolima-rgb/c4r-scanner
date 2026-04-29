const ADMIN_BASE = 'https://developer.api.autodesk.com/construction/admin/v1';

export interface AccProject {
  id: string;
  name: string;
  status: string;
  type: string;  // ACC | BIM360
  products?: { key: string; currentVersion: string }[];
}

export async function listAllProjects(
  accountId: string,
  token: string
): Promise<AccProject[]> {
  const projects: AccProject[] = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const url = `${ADMIN_BASE}/accounts/${accountId}/projects?limit=${limit}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Admin projects list failed: ${res.status}`);
    const data = await res.json();
    const results: AccProject[] = data.results ?? data.data ?? [];
    projects.push(...results);
    if (results.length < limit) break;
    offset += limit;
  }

  return projects;
}

export async function getProjectMemberCount(
  accountId: string,
  projectId: string,
  token: string
): Promise<number> {
  const url = `${ADMIN_BASE}/accounts/${accountId}/projects/${projectId}/users?limit=1`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return 0;
  const data = await res.json();
  return data.pagination?.totalResults ?? 0;
}
