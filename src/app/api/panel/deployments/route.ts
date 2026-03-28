export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';

const VERCEL_TOKEN = process.env.VERCEL_TOKEN;

interface VercelDeployment {
  uid: string;
  name: string;
  url: string;
  state: string;
  created: number;
  ready?: number;
  meta?: {
    githubCommitSha?: string;
    githubCommitMessage?: string;
    githubCommitRef?: string;
    githubCommitAuthorLogin?: string;
  };
  target?: string;
  inspectorUrl?: string;
}

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const { searchParams } = new URL(request.url);
  const projectName = searchParams.get('project');
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '15', 10), 30);

  if (!VERCEL_TOKEN) {
    return NextResponse.json({ error: 'VERCEL_TOKEN not configured', deployments: [] });
  }

  try {
    // Build URL with optional project filter
    let url = `https://api.vercel.com/v6/deployments?limit=${limit}`;
    
    // If project name specified, get project ID first
    if (projectName) {
      try {
        const projectRes = await fetch(`https://api.vercel.com/v9/projects/${encodeURIComponent(projectName)}`, {
          headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
        });
        if (projectRes.ok) {
          const project = await projectRes.json();
          url += `&projectId=${project.id}`;
        }
      } catch { /* fall through to unfiltered */ }
    }

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
    });

    if (!res.ok) {
      return NextResponse.json({ error: `Vercel API error: ${res.status}`, deployments: [] });
    }

    const data = await res.json();
    const deployments: VercelDeployment[] = (data.deployments ?? []).map((d: Record<string, unknown>) => ({
      uid: d.uid,
      name: d.name,
      url: d.url,
      state: d.state ?? d.readyState ?? 'UNKNOWN',
      created: d.created ?? d.createdAt,
      ready: d.ready,
      meta: d.meta,
      target: d.target,
      inspectorUrl: d.inspectorUrl,
    }));

    return NextResponse.json({ deployments, projectName });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message, deployments: [] });
  }
}
