import type { Emote } from './types';

export const emoteMap = new Map<string, string>(); // name -> id
export const emoteUrl = (id: string) => `https://cdn.7tv.app/emote/${id}/2x.webp`;
export const emoteUrlSm = (id: string) => `https://cdn.7tv.app/emote/${id}/1x.webp`;

export async function loadGlobalEmotes(): Promise<void> {
  try {
    const r = await fetch('https://7tv.io/v3/emote-sets/global');
    const d = await r.json();
    (d.emotes || []).forEach((e: any) => emoteMap.set(e.name, e.id));
  } catch { /* ignore */ }
}

export async function searchEmotes(query: string, page: number): Promise<Emote[]> {
  try {
    const body = {
      query: 'query($q:String!,$p:Int){emotes(query:$q,page:$p,limit:100,sort:{value:"popularity",order:DESCENDING}){items{id name}}}',
      variables: { q: query, p: page },
    };
    const r = await fetch('https://7tv.io/v3/gql', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const d = await r.json();
    const items: Emote[] = ((d.data && d.data.emotes && d.data.emotes.items) || []).map((e: any) => ({ id: e.id, name: e.name }));
    items.forEach((e) => emoteMap.set(e.name, e.id));
    return items;
  } catch { return []; }
}
