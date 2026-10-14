import type { Project } from '../../types/model';
import { SCHEMA_VERSION } from '../../types/model';

/**
 * 内置示例项目（方案.md v0.6 §7.2 任务 3）
 *
 * 为什么必须有它：目标用户是纯新手，在配置 API Key 之前，
 * 他必须能先看到一个「做完了长什么样」的完整例子，
 * 才能判断这个工具值不值得他继续折腾。
 *
 * 这份数据同时被单元测试使用——它故意埋了两处真实问题（见文件末尾说明），
 * 用来验证穿帮检查确实能抓到新手最常犯的错。
 */

const NOW = '2026-10-12T00:00:00.000Z';

function base() {
  return { schemaVersion: SCHEMA_VERSION, createdAt: NOW, updatedAt: NOW };
}

export const sampleProject: Project = {
  ...base(),
  id: 'sample-linjiao',
  name: '示例 · 林教头风雪山神庙',
  logline: '一个被诬陷的武人被发配草料场，在风雪夜里听见门外三人密谋，推门而出。',

  brief: {
    targetDuration: 40,
    aspectRatio: '16:9',
    platforms: ['jimeng', 'kling', 'seedance'],
    styleTone: '水墨写意 + 国漫赛璐璐，冷色调，大雪，厚重衣物质感',
    styleTags: [
      'Chinese ink wash painting style mixed with cel-shaded anime',
      'cold blue and grey palette',
      'heavy snowfall',
      'cinematic composition',
      'detailed fabric texture',
    ],
    negativePrompt:
      'modern clothing, bright saturated colors, text, watermark, logo, extra fingers, distorted face',
  },

  story: {
    ...base(),
    id: 'story-linjiao',
    source: 'original',
    body:
      '林冲被高俅陷害，刺配沧州，看守草料场。这夜大雪，他沽酒回来，见草厅被雪压塌，只得宿在山神庙里。' +
      '半夜听见门外有人说话，原来陆谦等人放火烧了草料场，要烧死他。林冲推门而出。',
    charactersNote: '林冲：原八十万禁军教头，被发配的武人。陆谦：昔日同窗，如今来害他的人。',
    setting: '北宋，沧州草料场，风雪之夜',
    conflict: '林冲是否听见真相、是否走出庙门',
    ending: '他推门而出，与门外三人正面相对',
    scenes: [
      { id: 'ss-1', label: '草料场外 · 大雪', summary: '林冲沽酒归来，风雪压塌草厅' },
      { id: 'ss-2', label: '山神庙内 · 夜', summary: '林冲在庙里听见门外密谋，推门而出' },
    ],
  },

  scenes: [
    {
      ...base(),
      id: 'sc-temple',
      name: '山神庙 · 风雪夜',
      identity: {
        placeType: '破败的山神庙',
        spatialStructure: '单间小屋，正面一扇对开的旧木门，门内左侧供桌，右侧墙角堆着草料',
        summary: '一座破败的山神庙，风雪夜',
        summaryEn:
          'a derelict mountain shrine interior at night, snow blowing in through a gap under the door',
      },
      variants: [
        {
          id: 'var-temple-dooropen',
          label: '庙门被推开',
          changedFeatures: ['木门敞开', '门槛外积雪被风吹入'],
          shotIds: ['shot-09', 'shot-10'],
        },
      ],
      continuityLocks: [
        {
          id: 'lock-temple-shape',
          label: '山神庙 · 空间与固定物',
          phrase:
            'a single-room shrine with a weathered double wooden door, a low altar table on the left, straw piled in the right corner',
          appliesTo: 'geography',
        },
      ],
      fixedElements: [
        'weathered double wooden door',
        'low altar table',
        'straw piled in the corner',
      ],
      lightDirection: '夜晚，唯一光源是门外雪地反光与桌上一盏残灯，冷调，光从门口方向斜射',
      mainColor: '冷灰蓝 + 残灯暖橙',
      timeOfDay: '夜晚',
      weather: '大雪',
      shotIds: ['shot-07', 'shot-08', 'shot-09', 'shot-10'],
    },
    {
      ...base(),
      id: 'sc-field',
      name: '草料场外 · 大雪',
      identity: {
        placeType: '被雪覆盖的草料场空地',
        spatialStructure: '开阔空地，左侧是被雪压塌的草厅，右侧通向山道，中景有堆成垛的草料',
        summary: '雪夜的草料场空地',
        summaryEn:
          'an open snow-covered fodder yard at night, a collapsed straw shed on the left, a mountain path on the right',
      },
      variants: [],
      continuityLocks: [
        {
          id: 'lock-field-shed',
          label: '草料场 · 塌掉的草厅',
          phrase: 'a collapsed straw shed with snow piled on its broken roof beams',
          appliesTo: 'geography',
        },
      ],
      fixedElements: ['collapsed straw shed', 'stacked straw bales', 'mountain path'],
      lightDirection: '夜晚，月光被云层遮住，光是雪地反上来的清冷散光，无明显投影',
      mainColor: '青灰 + 雪白',
      timeOfDay: '夜晚',
      weather: '大雪',
      shotIds: ['shot-01', 'shot-02', 'shot-03'],
    },
  ],

  characters: [
    {
      ...base(),
      id: 'ch-linchong',
      name: '林冲',
      role: 'protagonist',
      identity: {
        face: '三十余岁，方脸，眉浓而压，眼窝深，颧骨高',
        hair: '束发，戴一顶旧毡帽，鬓角有短须',
        bodyType: '高大瘦削，肩宽',
        ageRange: '三十余岁',
        summary: '林冲，三十余岁的武人，方脸浓眉，束发戴旧毡帽',
        summaryEn:
          'Lin Chong, a lean tall warrior in his thirties, square face, thick brows, hair tied up under an old felt hat',
      },
      variants: [
        {
          id: 'var-linchong-snow',
          label: '风雪中·满身落雪',
          changedFeatures: ['肩头与毡帽积雪', '衣袖被雪打湿变深'],
          shotIds: ['shot-01', 'shot-02', 'shot-10'],
        },
        {
          id: 'var-linchong-indoor',
          label: '庙内·雪已拂去',
          changedFeatures: ['雪已拂落', '毡帽取下放在供桌上'],
          shotIds: ['shot-07', 'shot-08'],
        },
      ],
      continuityLocks: [
        {
          id: 'lock-linchong-hat',
          label: '林冲 · 毡帽',
          // 这条锁就是「上一个镜头只有头巾、下一个镜头戴上了帽子」的修法：
          // 帽子原来只写在身份描述里，没有锁 → 没进提示词 → 有的镜头画了有的没画。
          phrase: 'a worn dark felt hat with a low pressed brim',
          appliesTo: 'look',
        },
        {
          id: 'lock-linchong-face',
          label: '林冲 · 面部',
          phrase: 'square face, thick lowering brows, deep-set eyes, short beard at the temples',
          appliesTo: 'look',
        },
        
        {
          id: 'lock-linchong-coat',
          label: '林冲 · 旧棉袍',
          phrase: 'a worn padded cotton robe in faded indigo, tied at the waist with a hemp cord',
          appliesTo: 'look',
        },
        {
          id: 'lock-linchong-spear',
          label: '林冲 · 花枪',
          phrase: 'a long wooden spear with a tarnished steel head',
          appliesTo: 'prop',
        },
      ],
      shotIds: ['shot-01', 'shot-02', 'shot-03', 'shot-07', 'shot-08', 'shot-10'],
      negativePrompt: 'modern clothing, clean new robe, bright colors, smiling',
      seed: 318742,
    },
    {
      ...base(),
      id: 'ch-luqian',
      name: '陆谦',
      role: 'antagonist',
      identity: {
        face: '四十岁上下，尖下巴，眼皮薄，嘴角习惯性上挑',
        hair: '文士巾，须修剪整齐',
        bodyType: '中等身量，略显清瘦',
        ageRange: '四十岁上下',
        summary: '陆谦，四十岁上下的文士，尖下巴薄眼皮，戴文士巾',
        summaryEn:
          'Lu Qian, a thin-faced scholar-official around forty, pointed chin, narrow eyelids, wearing a scholar cap',
      },
      variants: [],
      continuityLocks: [
        {
          id: 'lock-luqian-face',
          label: '陆谦 · 面部',
          phrase: 'pointed chin, narrow eyelids, a habitual smirk',
          appliesTo: 'look',
        },
      ],
      // 故意留一个缺口：本镜会出现他，但没有声明他的锁 —— 由穿帮检查指出来
      shotIds: [],
      negativePrompt: 'young face, muscular build',
    },
  ],

  shots: [
    {
      id: 'shot-01',
      number: 1,
      duration: 4,
      shotSize: 'extreme-wide',
      cameraPosition: '略高角度，俯看整片空地',
      cameraMove: 'static',
      startState:
        '大雪夜的草料场空地；左侧是被雪压塌的草厅，屋梁断口朝天；中景堆着几垛草料；画面右侧一条山道没入风雪',
      action: '一个人影从山道尽头走进画面，肩头落满雪',
      endState: '人影停在空地中央偏右，背对镜头，长枪斜挎在背上',
      dialogue: '',
      sound: '风雪呼啸，远处草料被压塌的闷响',
      mood: '孤寂，压迫',
      transition: '硬切',
      sceneId: 'sc-field',
      characterIds: ['ch-linchong'],
      variantIds: ['var-linchong-snow'],
      activeLockIds: ['lock-linchong-face', 'lock-linchong-coat', 'lock-linchong-spear'],
      offscreenCharacters: [],
      sourceSceneId: 'ss-1',
    },
    {
      id: 'shot-02',
      number: 2,
      duration: 3,
      shotSize: 'medium',
      cameraPosition: '与胸口齐平，正面偏侧',
      cameraMove: 'push-in',
      startState:
        '林冲侧身站在雪地里，旧棉袍肩头积着雪，毡帽压得低，右手扶着斜挎的花枪',
      action: '他缓缓转头，望向塌掉的草厅方向',
      endState: '他的视线定在断梁上，眉头压下',
      dialogue: '',
      sound: '风声压低，一声木梁开裂的脆响',
      mood: '警觉',
      transition: '硬切',
      sceneId: 'sc-field',
      characterIds: ['ch-linchong'],
      variantIds: ['var-linchong-snow'],
      activeLockIds: ['lock-linchong-face', 'lock-linchong-coat', 'lock-linchong-spear'],
      offscreenCharacters: [],
      sourceSceneId: 'ss-1',
    },
    {
      id: 'shot-03',
      number: 3,
      duration: 4,
      shotSize: 'close-up',
      cameraPosition: '略低角度，仰拍',
      cameraMove: 'handheld',
      startState: '林冲的面部特写，雪片擦过毡帽前沿，睫毛上挂着未化的雪',
      action: '他抬手拂去肩上的雪，把花枪换到左手',
      endState: '他的手停在肩上，眼神转向山神庙的方向',
      dialogue: '',
      sound: '布料摩擦声，脚步踩进雪里的吱嘎声',
      mood: '决断前的静',
      transition: '叠化',
      sceneId: 'sc-field',
      characterIds: ['ch-linchong'],
      variantIds: ['var-linchong-snow'],
      activeLockIds: ['lock-linchong-face', 'lock-linchong-coat'],
      offscreenCharacters: [],
      sourceSceneId: 'ss-1',
    },
    {
      id: 'shot-07',
      number: 4,
      duration: 3,
      shotSize: 'wide',
      cameraPosition: '室内，从门口向内看',
      cameraMove: 'static',
      startState:
        '山神庙内，斑驳的土墙上映着一盏残灯的暖橙光；左侧供桌，右侧墙角堆着草料；对开的旧木门关着',
      action: '残灯的火苗被门缝灌进来的风压得一矮',
      endState: '灯火重新立起，门缝里透进一线雪地的冷光',
      dialogue: '',
      sound: '门外风雪声，灯芯爆了一下',
      mood: '压抑的安静',
      transition: '硬切',
      sceneId: 'sc-temple',
      characterIds: [],
      variantIds: [],
      activeLockIds: ['lock-temple-shape'],
      offscreenCharacters: [],
      sourceSceneId: 'ss-2',
    },
    {
      id: 'shot-08',
      number: 5,
      duration: 5,
      shotSize: 'medium',
      cameraPosition: '与坐姿齐平，正面',
      cameraMove: 'static',
      startState:
        '林冲坐在供桌旁，毡帽取下放在桌沿，旧棉袍上的雪已经拂去；墙上他的影子被残灯拉得很长',
      action: '他闭着眼，手按在花枪杆上，一动不动',
      endState: '他的耳朵动了一下，眼睛睁开',
      dialogue: '',
      sound: '门外传来三个人的脚步声，压低的说话声',
      mood: '警觉到极点',
      transition: '硬切',
      sceneId: 'sc-temple',
      characterIds: ['ch-linchong'],
      variantIds: ['var-linchong-indoor'],
      activeLockIds: ['lock-linchong-face', 'lock-linchong-coat', 'lock-temple-shape'],
      offscreenCharacters: ['陆谦'],
      sourceSceneId: 'ss-2',
    },
    {
      id: 'shot-09',
      number: 6,
      duration: 4,
      shotSize: 'close-up',
      cameraPosition: '门内侧，贴近门板',
      cameraMove: 'push-in',
      startState: '旧木门的门板特写，门缝里透进一缕雪地的白光，木纹和裂缝清晰',
      action: '林冲一只手撑上左边那扇门板，指节抵着木纹',
      endState: '门板被推开一条缝，雪片被风卷进来落在门槛上',
      dialogue: '门外（低声）：烧了这草料场，他还能活？',
      sound: '门轴干涩的转动声，风雪灌入',
      mood: '真相压顶',
      transition: '硬切',
      sceneId: 'sc-temple',
      characterIds: ['ch-linchong'],
      variantIds: ['var-temple-dooropen'],
      activeLockIds: ['lock-temple-shape'],
      offscreenCharacters: ['陆谦'],
      sourceSceneId: 'ss-2',
    },
    {
      id: 'shot-10',
      number: 7,
      duration: 5,
      shotSize: 'full',
      cameraPosition: '从门外平视庙门',
      cameraMove: 'pull-out',
      startState:
        '夜里正午的顶光直射下来，庙门口一片刺眼的亮；门外站着三个人影，被光晃得看不清脸',
      action: '林冲提着花枪跨出门槛',
      endState: '他站在门槛外，身后庙门大开，长枪枪尖指向三人',
      dialogue: '',
      sound: '风雪声忽然盖过一切，然后静下来',
      mood: '爆发',
      transition: '闪白',
      sceneId: 'sc-temple',
      characterIds: ['ch-linchong'],
      // 注意：这里**不**挂 'var-temple-dooropen'（那是「庙门被推开」的变体）。
      // 挂了它，光线冲突就会被当成「剧情有意为之」而豁免，
      // 而这一镜的问题恰恰是写成了「夜里正午的顶光」——必须能被抓出来。
      variantIds: ['var-linchong-snow'],
      activeLockIds: ['lock-linchong-face', 'lock-linchong-coat', 'lock-linchong-spear'],
      offscreenCharacters: ['陆谦'],
      sourceSceneId: 'ss-2',
    },
  ],
};

/**
 * 这份示例项目里故意留下的问题（供演示与测试）：
 *
 * 1. shot-10 的起点写的是「夜里正午的顶光直射」——与场景卡「夜晚，冷调，光从门口斜射」
 *    冲突。穿帮检查应当报出 scene-light-conflict。
 *    这正是新手最容易犯的错：写画面时随手加了个「亮」，结果把夜里写成了正午。
 *
 * 2. shot-10 的动作「提着花枪跨出门槛」是单一动作，但 shot-03 的
 *    「抬手拂去肩上的雪，把花枪换到左手」含两个动作片段，
 *    穿帮检查应当报出 multi-action（警告）。
 *
 * 3. 陆谦在 shot-08 / shot-09 / shot-10 的画外被提到，但他没有任何镜头出镜、
 *    也没有声明连续性锁，穿帮检查应当给出相应提示。
 *
 * 4. shot-01 → shot-03 属于 ss-1，shot-07 → shot-10 属于 ss-2，
 *    两个场次都有镜头承载，因此不该报 story-scene-uncovered。
 */
