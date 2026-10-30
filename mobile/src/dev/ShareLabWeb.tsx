// Dev-only web grid of share cards for visual QA (PKL-013): every layout of a
// lab sample (lib/shareCardLab), post and story, side by side. Reached only on
// a dev web server at /?sharelab (index.ts checks __DEV__ before requiring it),
// never in a production bundle's path. Query:
//   sample=<id>|all   photos=0|1|2|4   look=<look id>|all   aspect=post|story|both
//   details=default|all|none   banner=<banner id>   logo=full|small   template=<id>
// Photos are drawn SVG placeholders (portrait, landscape, square) with a face
// marker in the upper third, so cropping is easy to judge offline.
import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import ShareCardArt from '../components/share/ShareCardArt';
import { labSamples } from '../lib/shareCardLab';
import {
  SHARE_BANNER_DEFAULT,
  SHARE_BANNER_FALLBACK,
  SHARE_LOOK_IDS,
  SHARE_TEMPLATE_LABEL,
  shareDefaultDetails,
  shareDetailOptions,
  shareTemplatesFor,
  type ShareTemplateId,
} from '../lib/shareCards';

const W = 300;

function photo(w: number, h: number, hue: number, label: string): string {
  // A "player" drawn on a canvas (web only): sky, court, a body and a head with
  // a red ring, roughly where a phone photo puts them.
  if (typeof document === 'undefined') return '';
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  if (!g) return '';
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, `hsl(${hue},55%,70%)`);
  grad.addColorStop(1, `hsl(${hue + 40},45%,35%)`);
  g.fillStyle = grad; g.fillRect(0, 0, w, h);
  g.fillStyle = `hsl(${hue + 120},35%,40%)`; g.fillRect(0, h * 0.62, w, h * 0.38);
  g.strokeStyle = '#fff'; g.lineWidth = w / 120; g.beginPath(); g.moveTo(0, h * 0.75); g.lineTo(w, h * 0.75); g.stroke();
  const cx = w / 2, headY = h * 0.3, r = Math.min(w, h) * 0.09;
  g.fillStyle = '#2b2b2b'; g.fillRect(cx - r * 1.3, headY + r, r * 2.6, h * 0.38);
  g.fillStyle = '#f1c7a0'; g.beginPath(); g.arc(cx, headY, r, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#e33'; g.lineWidth = w / 150; g.stroke();
  g.fillStyle = '#fff'; g.font = `${Math.round(w / 18)}px sans-serif`; g.fillText(label, w * 0.04, h * 0.07);
  return c.toDataURL('image/jpeg', 0.85);
}

const PHOTOS = [
  photo(900, 1200, 200, 'portrait 3:4'),
  photo(1200, 900, 30, 'landscape 4:3'),
  photo(1000, 1000, 280, 'square'),
  photo(900, 1600, 120, 'tall 9:16'),
];

function param(q: URLSearchParams, k: string, d: string): string {
  return q.get(k) ?? d;
}

export default function ShareLabWeb() {
  const q = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
  const sampleQ = param(q, 'sample', 'all');
  const n = Number(param(q, 'photos', '0'));
  const lookQ = param(q, 'look', 'court');
  const aspectQ = param(q, 'aspect', 'both');
  const detailsQ = param(q, 'details', 'default');
  const bannerQ = q.get('banner');
  const logo = param(q, 'logo', 'full');
  const templateQ = q.get('template');

  const samples = labSamples().filter((s) => sampleQ === 'all' || s.id === sampleQ || s.group.toLowerCase() === sampleQ);
  const looks = lookQ === 'all' ? SHARE_LOOK_IDS : [lookQ];
  const aspects = (aspectQ === 'both' ? ['post', 'story'] : [aspectQ]) as ('post' | 'story')[];
  const photos = PHOTOS.slice(0, n);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: '#888' }} contentContainerStyle={{ padding: 12, gap: 16 }}>
      {samples.map((smp) => {
        const base = shareDefaultDetails(smp.model);
        const details: Record<string, boolean> =
          detailsQ === 'all' ? Object.fromEntries(shareDetailOptions(smp.model).map((o) => [o.id, true]))
          : detailsQ === 'none' ? Object.fromEntries(Object.keys(base).map((k) => [k, false]))
          : base;
        const templates = shareTemplatesFor(n, smp.model.kind).filter((t) => !templateQ || t === templateQ);
        return (
          <View key={smp.id} nativeID={`sample-${smp.id}`} style={{ gap: 6 }}>
            <Text style={{ color: '#fff', fontWeight: '800', fontSize: 14 }}>{smp.id} · {smp.label} · {n} photos · details {detailsQ}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'flex-start' }}>
              {templates.flatMap((t: ShareTemplateId) =>
                looks.flatMap((look) =>
                  aspects.map((aspect) => {
                    const height = Math.round(W / (aspect === 'post' ? 4 / 5 : 9 / 16));
                    const banner = bannerQ ?? SHARE_BANNER_DEFAULT[t] ?? SHARE_BANNER_FALLBACK;
                    const s = { template: t, aspect, look, banner, logo, details, photos, width: W, height };
                    return (
                      <View key={`${t}-${look}-${aspect}`} style={{ gap: 3 }}>
                        <Text style={{ color: '#fff', fontSize: 10 }}>{SHARE_TEMPLATE_LABEL[t]} · {look} · {aspect}</Text>
                        <View style={{ width: W, height, overflow: 'hidden' }}>
                          <ShareCardArt s={s} model={smp.model} />
                        </View>
                      </View>
                    );
                  }),
                ),
              )}
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}
