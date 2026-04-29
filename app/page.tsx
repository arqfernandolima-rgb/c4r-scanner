'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

interface Hub {
  id: string;
  name: string;
  region: string;
}

interface User {
  name: string;
  email: string;
}

export default function HomePage() {
  const [user, setUser] = useState<User | null>(null);
  const [hubs, setHubs] = useState<Hub[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get('error');
    if (err) setError(decodeURIComponent(err));

    fetch('/api/auth/me')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && !data.error) {
          setUser(data);
          return fetch('/api/hubs').then(r => r.json());
        }
        return null;
      })
      .then(data => {
        if (data?.hubs) setHubs(data.hubs);
      })
      .finally(() => setLoading(false));
  }, []);

  const handleHubSelect = (hub: Hub) => {
    localStorage.setItem('selected_hub', JSON.stringify(hub));
    window.location.href = '/dashboard';
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-full max-w-sm space-y-6 p-8">
          <div>
            <h1 className="text-xl font-semibold">Revit C4R Scanner</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Identify deprecated Collaboration for Revit files across your ACC/BIM 360 hub.
            </p>
          </div>

          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              Login failed: {error}
            </div>
          )}

          <Button asChild className="w-full">
            <a href="/api/auth/login">Sign in with Autodesk</a>
          </Button>

          <p className="text-xs text-muted-foreground text-center">
            You must be an ACC Account Admin to use this tool.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-md space-y-6 p-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">Select hub</h1>
            <p className="text-sm text-muted-foreground">Signed in as {user.name}</p>
          </div>
          <Button variant="ghost" size="sm" asChild>
            <a href="/api/auth/logout">Sign out</a>
          </Button>
        </div>

        {hubs.length === 0 ? (
          <div className="text-sm text-muted-foreground">No hubs found.</div>
        ) : (
          <div className="space-y-2">
            {hubs.map(hub => (
              <button
                key={hub.id}
                onClick={() => handleHubSelect(hub)}
                className="w-full text-left rounded-md border px-4 py-3 hover:bg-muted transition-colors"
              >
                <div className="font-medium text-sm">{hub.name}</div>
                <div className="text-xs text-muted-foreground">{hub.region} · {hub.id}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
