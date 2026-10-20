// Flat ink-wash storyboard frames for the three proposals.
// Drawn in code because the sample project ships without generated stills.
// Every frame uses the page's own tokens: --frame-paper, --frame-ink,
// --frame-snow, --frame-warm, so the same drawings sit in a light or dark sheet.

const dots = (seed) => {
  let s = seed;
  const rand = () => {
    s = (s * 16807 + 11) % 2147483647;
    return s / 2147483647;
  };
  return Array.from({ length: 26 }, () => {
    const x = 8 + rand() * 304;
    const y = 8 + rand() * 164;
    const r = 0.6 + rand() * 1.9;
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="var(--frame-snow)" opacity="${(0.35 + rand() * 0.55).toFixed(2)}"/>`;
  }).join('');
};

const svg = (content, seed = 3) => `
<svg viewBox="0 0 320 180" role="img" aria-hidden="true" preserveAspectRatio="xMidYMid slice">
  <rect width="320" height="180" fill="var(--frame-paper)"/>
  ${content}
  ${dots(seed)}
</svg>`;

const figure = (x, y, scale = 1, flip = false) => `
  <g transform="translate(${x} ${y}) scale(${flip ? -scale : scale} ${scale})" fill="var(--frame-ink)">
    <path d="M-7 0 L-8 -34 Q-8 -46 0 -47 Q8 -46 8 -34 L7 0 Z"/>
    <circle cx="0" cy="-53" r="8"/>
    <path d="M-12 -51 Q0 -60 12 -51 L10 -57 Q0 -64 -10 -57 Z" fill="var(--frame-ink)"/>
    <path d="M8 -43 L24 -77 L27 -76 L12 -40 Z"/>
  </g>`;

export const frames = [
  {
    n: 1,
    dur: 4,
    scene: '草料场外',
    size: '大远景',
    label: '雪压草厅，人从山道尽头走来',
    svg: svg(
      `<path d="M0 118 Q54 106 102 116 Q176 128 320 112 L320 180 L0 180 Z" fill="var(--frame-snow)" opacity=".7"/>
       <path d="M0 136 Q90 126 320 138 L320 180 L0 180 Z" fill="var(--frame-ink)" opacity=".12"/>
       <path d="M36 112 L52 82 L116 82 L130 112 Z" fill="var(--frame-ink)" opacity=".82"/>
       <path d="M46 82 L84 66 L122 82 Z" fill="var(--frame-ink)"/>
       <path d="M52 86 L112 86 L112 94 L52 94 Z" fill="var(--frame-snow)" opacity=".5"/>
       <path d="M252 116 L276 84 L296 116 Z" fill="var(--frame-ink)" opacity=".55"/>
       <path d="M214 116 Q236 108 262 116" stroke="var(--frame-ink)" stroke-width="1.4" fill="none" opacity=".35"/>
       ${figure(168, 120, 0.55)}
       <path d="M182 117 L205 128" stroke="var(--frame-ink)" stroke-width="1.2" opacity=".55"/>`,
      11,
    ),
  },
  {
    n: 2,
    dur: 3,
    scene: '草料场外',
    size: '中景',
    label: '林冲侧身站定，转头望向塌掉的草厅',
    svg: svg(
      `<path d="M0 140 Q86 126 320 146 L320 180 L0 180 Z" fill="var(--frame-snow)" opacity=".8"/>
       <path d="M0 120 L34 96 L96 96 L118 120 Z" fill="var(--frame-ink)" opacity=".25"/>
       <path d="M0 124 L118 124 L118 132 L0 132 Z" fill="var(--frame-ink)" opacity=".18"/>
       <g transform="translate(182 150) scale(1.55)" fill="var(--frame-ink)">
         <path d="M-13 0 L-15 -58 Q-15 -76 0 -78 Q15 -76 15 -58 L13 0 Z"/>
         <circle cx="0" cy="-88" r="12"/>
         <path d="M-20 -84 Q0 -98 20 -84 L16 -94 Q0 -104 -16 -94 Z"/>
         <path d="M14 -60 L42 -108 L47 -105 L21 -56 Z"/>
         <path d="M-14 -56 L-28 -20" stroke="var(--frame-ink)" stroke-width="6"/>
       </g>
       <path d="M120 78 L168 62" stroke="var(--frame-ink)" stroke-width="1.2" opacity=".2"/>`,
      23,
    ),
  },
  {
    n: 3,
    dur: 4,
    scene: '草料场外',
    size: '特写',
    label: '抬手拂去肩上的雪，把花枪换到左手',
    svg: svg(
      `<rect x="0" y="0" width="320" height="180" fill="var(--frame-ink)" opacity=".07"/>
       <g transform="translate(160 196) scale(3.6)" fill="var(--frame-ink)">
         <path d="M-17 0 L-19 -52 Q-19 -72 0 -74 Q19 -72 19 -52 L17 0 Z"/>
         <circle cx="0" cy="-84" r="15"/>
         <path d="M-24 -79 Q0 -98 24 -79 L19 -91 Q0 -106 -19 -91 Z"/>
         <path d="M-16 -80 Q-8 -72 0 -80 Q8 -72 16 -80" stroke="var(--frame-snow)" stroke-width="2" fill="none" opacity=".45"/>
         <path d="M-7 -87 L-3 -87 M4 -87 L8 -87" stroke="var(--frame-snow)" stroke-width="2"/>
         <path d="M-2 -70 L0 -62" stroke="var(--frame-snow)" stroke-width="1.4" opacity=".35"/>
       </g>
       <path d="M28 160 L150 38" stroke="var(--frame-ink)" stroke-width="3"/>
       <path d="M28 160 L150 38" stroke="var(--frame-snow)" stroke-width="1" opacity=".35"/>
       <path d="M0 158 Q60 146 120 158" stroke="var(--frame-ink)" stroke-width="1" opacity=".18"/>`,
      31,
    ),
  },
  {
    n: 4,
    dur: 3,
    scene: '山神庙内',
    size: '全景',
    label: '残灯照着的庙内，门缝透进雪的冷光',
    svg: svg(
      `<rect x="0" y="0" width="320" height="180" fill="var(--frame-ink)" opacity=".92"/>
       <path d="M122 28 L198 28 L198 152 L122 152 Z" fill="var(--frame-warm)" opacity=".22"/>
       <path d="M140 34 L182 34 L182 148 L140 148 Z" fill="var(--frame-warm)" opacity=".45"/>
       <path d="M161 34 L161 148" stroke="var(--frame-ink)" stroke-width="3"/>
       <path d="M0 152 L320 152 L320 180 L0 180 Z" fill="var(--frame-ink)"/>
       <path d="M34 112 L102 112 L102 132 L34 132 Z" fill="var(--frame-ink)" opacity=".55"/>
       <path d="M34 102 L102 102 L102 112 L34 112 Z" fill="var(--frame-warm)" opacity=".25"/>
       <circle cx="78" cy="96" r="4" fill="var(--frame-warm)"/>
       <path d="M232 128 L304 122 L304 154 L232 154 Z" fill="var(--frame-ink)" opacity=".7"/>
       <path d="M232 128 L304 122" stroke="var(--frame-snow)" stroke-width="2" opacity=".35"/>
       <path d="M186 152 L206 86 L236 86 L248 152 Z" fill="var(--frame-snow)" opacity=".16"/>`,
      43,
    ),
  },
  {
    n: 5,
    dur: 5,
    scene: '山神庙内',
    size: '中景',
    label: '林冲闭眼坐在供桌旁，手按在花枪杆上',
    svg: svg(
      `<rect x="0" y="0" width="320" height="180" fill="var(--frame-ink)" opacity=".94"/>
       <path d="M0 144 L320 144 L320 180 L0 180 Z" fill="var(--frame-ink)"/>
       <path d="M220 18 L268 18 L268 128 L220 128 Z" fill="var(--frame-warm)" opacity=".1"/>
       <path d="M220 18 L268 18 L268 24 L220 24 Z" fill="var(--frame-warm)" opacity=".3"/>
       <g transform="translate(126 150) scale(1.6)" fill="var(--frame-ink)">
         <path d="M-30 0 L-30 -20 Q-26 -42 0 -44 Q26 -42 30 -20 L30 0 Z"/>
         <circle cx="0" cy="-54" r="13"/>
         <path d="M-16 -50 Q0 -64 16 -50 L13 -60 Q0 -71 -13 -60 Z"/>
         <path d="M-24 -38 L-54 -32 L-52 -24 L-22 -30 Z"/>
       </g>
       <path d="M50 170 L96 60" stroke="var(--frame-ink)" stroke-width="4"/>
       <circle cx="88" cy="84" r="5" fill="var(--frame-warm)"/>
       <path d="M88 84 L96 74" stroke="var(--frame-warm)" stroke-width="1" opacity=".6"/>
       <path d="M176 150 L306 150" stroke="var(--frame-warm)" stroke-width="1" opacity=".12"/>`,
      53,
    ),
  },
  {
    n: 6,
    dur: 4,
    scene: '山神庙内',
    size: '特写',
    label: '一只手撑上左边门板，指节抵着木纹',
    svg: svg(
      `<rect x="0" y="0" width="320" height="180" fill="var(--frame-ink)"/>
       <g stroke="var(--frame-warm)" stroke-width="1" opacity=".18">
         <path d="M22 0 L22 180"/><path d="M54 0 L54 180"/><path d="M86 0 L86 180"/>
         <path d="M118 0 L118 180"/><path d="M150 0 L150 180"/><path d="M182 0 L182 180"/>
         <path d="M214 0 L214 180"/><path d="M246 0 L246 180"/><path d="M278 0 L278 180"/>
       </g>
       <path d="M232 0 L260 0 L260 180 L232 180 Z" fill="var(--frame-snow)" opacity=".16"/>
       <path d="M242 0 L252 0 L252 180 L242 180 Z" fill="var(--frame-paper)" opacity=".92"/>
       <g transform="translate(70 56) scale(0.6)" stroke="var(--frame-ink)" stroke-width="1.6">
         <path d="M58 176 L50 148 Q48 136 62 130 L96 142 L104 164 L96 176 Z" fill="var(--frame-ink)" stroke="var(--frame-paper)" stroke-width="1.2"/>
         <path d="M94 166 Q88 150 94 134 L98 116 Q99 108 106 108 L110 108 Q116 108 117 116 L120 136 L122 102 Q123 94 130 94 Q137 94 138 102 L140 136 L144 96 Q145 88 152 88 Q159 88 160 96 L162 136 L167 103 Q168 96 175 96 Q182 96 183 104 L184 150 Q184 166 168 168 Z" fill="var(--frame-paper)"/>
         <g fill="none" stroke-width="1.2" opacity=".45">
           <path d="M111 118 L113 150"/><path d="M129 110 L131 150"/>
           <path d="M147 108 L149 150"/><path d="M165 112 L167 150"/>
           <path d="M104 132 L118 130"/><path d="M122 128 L136 126"/><path d="M140 126 L154 124"/>
         </g>
         <path d="M94 166 L80 172 L76 160 L96 148 Z" fill="var(--frame-ink)" stroke="var(--frame-paper)" stroke-width="1"/>
       </g>
       <path d="M84 58 L96 42" stroke="var(--frame-snow)" stroke-width="1.2" opacity=".3"/>
       <path d="M206 30 L206 78" stroke="var(--frame-snow)" stroke-width="1" opacity=".28"/>`,
      61,
    ),
  },
  {
    n: 7,
    dur: 5,
    scene: '山神庙外',
    size: '全景',
    label: '林冲提着花枪跨出门槛，门外三人被光晃着',
    svg: svg(
      `<rect x="0" y="0" width="320" height="180" fill="var(--frame-ink)"/>
       <path d="M96 24 L224 24 L224 162 L96 162 Z" fill="var(--frame-paper)" opacity=".92"/>
       <path d="M110 48 L210 48 L210 162 L110 162 Z" fill="var(--frame-snow)" opacity=".28"/>
       ${figure(160, 162, 1.45)}
       <path d="M146 106 L104 54 L98 58 L138 110 Z" fill="var(--frame-ink)"/>
       <g fill="var(--frame-ink)" opacity=".85">
         <path d="M64 162 L60 128 Q60 118 68 117 Q76 118 76 128 L72 162 Z"/><circle cx="68" cy="111" r="6"/>
         <path d="M84 164 L81 136 Q81 127 88 126 Q95 127 95 136 L92 164 Z"/><circle cx="88" cy="121" r="5"/>
         <path d="M246 162 L242 128 Q242 118 250 117 Q258 118 258 128 L254 162 Z"/><circle cx="250" cy="111" r="6"/>
       </g>
       <path d="M0 164 L320 164 L320 180 L0 180 Z" fill="var(--frame-ink)"/>
       <path d="M96 24 L224 24" stroke="var(--frame-warm)" stroke-width="2" opacity=".2"/>`,
      71,
    ),
  },
];
