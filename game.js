let BPM = 120;
let BEAT_INTERVAL = 60 / BPM; // 1拍の長さ(秒) = 0.5s
let TIMING_PERFECT = 0.05; // ±50ms (さらにシビアに)
let TIMING_GOOD = 0.08;    // ±80ms (さらにシビアに)

const SCALE = {
    DO: 523.25,
    RE: 587.33,
    MI: 659.25,
    FA: 698.46,
    SO: 783.99,
    LA: 880.00,
    TI: 987.77,
    NORMAL: 880
};

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 300;
const GROUND_Y = 240;
const PLAYER_X = 100;
let SCROLL_SPEED = 350;

// --- 状態管理 ---
let audioCtx = null;
let masterGain = null; // マスターボリュームノード
let scheduleTimeout = null; // スケジュールタイムアウトID（キャンセル用）
let startTime = 0;
let isPlaying = false;
let isGameOver = false;
let isHardMode = false;
const eventTypes = ['hole', 'bird', 'stairs', 'cactus', 'single_spike', 'triple_jump', 'cactus_triplet'];
let nextEventType = 'hole'; // 初期ギミック
let score = 0;
let combo = 0;
let nextBeatTime = 0;
let currentBeatCount = 0; // 曲が始まってからの通算拍数
let targetBeat = 4; // 次の穴が到達する通算拍数
let animationId = null; // requestAnimationFrameのIDを管理

// --- エフェクト状態管理 ---
let activeEffect = null; // 'darkness' または 'inverted' または null
let effectEndTime = 0;   // エフェクト終了時間(audioCtx.currentTime)
let lastEffectScoreThreshold = 2000; // 次にエフェクトが発動するスコア閾値
let speedUpPhase = 0; // 0: 平常, 1: 文字演出中
let speedUpStartTime = 0;
let nextSpeedUpScore = 2500;
let speedMultiplier = 1.0;
let isSpeedUpPending = false;

// --- Canvas描画関連 ---
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

const startBtn = document.getElementById('start-btn');
const startScreen = document.getElementById('start-screen');

// プレイヤーオブジェクト
const player = {
    x: PLAYER_X,
    y: GROUND_Y - 60,
    width: 30,
    height: 60,
    vy: 0,
    gravity: 1.0,
    jumpPower: -13,
    isJumping: false,
    maxJumps: 1, // 空中ジャンプ廃止
    jumpCount: 0,
    color: '#535353',
    
    update(floorY = GROUND_Y) {
        this.y += this.vy;
        this.vy += this.gravity;
        
        // 指定された床（地面またはブロック）に着地
        if (this.y >= floorY - this.height) {
            this.y = floorY - this.height;
            this.vy = 0;
            this.isJumping = false;
            this.jumpCount = 0;
        }
    },
    
    jump() {
        if (this.jumpCount < this.maxJumps) {
            this.vy = this.jumpPower;
            this.isJumping = true;
            this.jumpCount++;
            return true; // ジャンプ成功
        }
        return false; // ジャンプできなかった（空中など）
    },
    
    draw(ctx) {
        ctx.fillStyle = this.color;
        const x = this.x;
        const y = this.y;
        
        // T-Rex風のドット絵シルエット
        // 頭
        ctx.fillRect(x + 12, y, 18, 15);
        ctx.fillRect(x + 15, y + 15, 20, 8); // 鼻面
        
        // 目
        ctx.fillStyle = '#fff';
        ctx.fillRect(x + 16, y + 3, 4, 4);
        ctx.fillStyle = this.color;
        
        // 胴体と首
        ctx.fillRect(x + 10, y + 15, 12, 10);
        ctx.fillRect(x + 5, y + 25, 20, 20);
        
        // 背中と尻尾
        ctx.fillRect(x, y + 25, 5, 10);
        ctx.fillRect(x - 5, y + 35, 10, 5);
        
        // 腕
        ctx.fillRect(x + 20, y + 28, 6, 4);
        
        // 足
        if (this.isJumping) {
            ctx.fillRect(x + 8, y + 45, 5, 10);
            ctx.fillRect(x + 18, y + 45, 5, 5);
        } else {
            const isAlt = Math.floor(Date.now() / 150) % 2 === 0;
            if (isAlt) {
                ctx.fillRect(x + 8, y + 45, 5, 15);
                ctx.fillRect(x + 18, y + 45, 5, 10);
            } else {
                ctx.fillRect(x + 8, y + 45, 5, 10);
                ctx.fillRect(x + 18, y + 45, 5, 15);
            }
        }
    }
};

// 障害物（落とし穴）の配列
let obstacles = [];
// 判定表示用の配列（エフェクト）
let judgements = [];
// 着地時にまとめて処理する判定の保留配列
let pendingJudgements = [];

// スクロール速度： 穴が右端(800)からプレイヤー位置(100)に来るまでを4拍(4 * BEAT_INTERVAL秒)とする
const DISTANCE_TO_PLAYER = CANVAS_WIDTH - PLAYER_X;
const TIME_TO_REACH_PLAYER = 4 * BEAT_INTERVAL;
// SCROLL_SPEED は先頭で let で宣言済み

// --- 初期化 ---
function init() {
    startBtn.addEventListener('click', () => startGame(false));
    document.getElementById('hard-start-btn').addEventListener('click', () => startGame(true));
    window.addEventListener('keydown', handleInput);
    
    // 初期描画
    drawFrame();
}

function showStartScreen() {
    isPlaying = false;
    isGameOver = false;
    
    if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
    }
    
    startScreen.classList.remove('hidden');
    
    // ボタンのフォーカスが残っているとスペースキーで誤爆（すぐリスタート）してしまうためフォーカスを外す
    if (document.activeElement) {
        document.activeElement.blur();
    }
    
    // 画面をリセット
    score = 0;
    combo = 0;
    obstacles = [];
    judgements = [];
    activeEffect = null;
    player.y = GROUND_Y - player.height;
    player.vy = 0;
    player.color = '#535353';
    drawFrame();
}

async function startGame(hardMode = false) {
    // プレイ中にキー操作でボタンが誤爆しないように、ボタンのフォーカスを外す
    if (document.activeElement) {
        document.activeElement.blur();
    }
    
    // 古いスケジュールタイムアウトがあればキャンセルして混入を防ぐ
    if (scheduleTimeout) {
        clearTimeout(scheduleTimeout);
        scheduleTimeout = null;
    }
    
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        // マスターボリュームノードを作成して全体音量を50%に設定
        masterGain = audioCtx.createGain();
        masterGain.gain.value = 0.5;
        masterGain.connect(audioCtx.destination);
    }
    
    if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
    }

    startScreen.classList.add('hidden');
    score = 0;
    combo = 0;
    currentBeatCount = 0;
    targetBeat = 4;
    obstacles = [];
    judgements = [];
    pendingJudgements = [];
    isGameOver = false;
    nextEventType = eventTypes[Math.floor(Math.random() * eventTypes.length)];
    
    // エフェクト関連リセット
    isHardMode = hardMode;
    if (isHardMode) {
        activeEffect = 'darkness';
        effectEndTime = Infinity; // ずっと暗闇
    } else {
        activeEffect = null;
        effectEndTime = 0;
    }
    lastEffectScoreThreshold = 2000;
    
    // スピードアップ関連リセット
    BPM = 120;
    BEAT_INTERVAL = 60 / BPM;
    SCROLL_SPEED = 350;
    speedUpPhase = 0;
    speedUpStartTime = 0;
    nextSpeedUpScore = 2500;
    speedMultiplier = 1.0;
    isSpeedUpPending = false;
    TIMING_PERFECT = 0.05; // リセット
    TIMING_GOOD = 0.08;    // リセット
    
    // プレイヤーの初期化
    player.gravity = 1.0;
    player.jumpPower = -13;
    player.y = GROUND_Y - player.height;
    player.vy = 0;
    player.isJumping = false;
    player.jumpCount = 0;
    player.color = '#535353';
    
    // 開始猶予
    startTime = audioCtx.currentTime + 1.0; 
    nextBeatTime = startTime;
    
    isPlaying = true;
    
    scheduleAudioAndGameEvents();
    
    // 古いループが回っていればキャンセルして多重登録を防ぐ
    if (animationId) {
        cancelAnimationFrame(animationId);
    }
    animationId = requestAnimationFrame(gameLoop);
}

// --- オーディオとイベントのスケジュール ---
function scheduleAudioAndGameEvents() {
    if (!isPlaying || isGameOver) return;
    
    const lookahead = 0.1;
    const scheduleAheadTime = 0.5;
    
    while (nextBeatTime < audioCtx.currentTime + scheduleAheadTime) {
        // 常にキック音（BGMベース）
        playKick(nextBeatTime);
        
        // --- BGM（バックグラウンドミュージック）---
        // 4小節ループのポップなコード進行 (C -> G -> Am -> F)
        const measure = Math.floor(currentBeatCount / 4) % 4;
        let rootFreq = SCALE.DO;
        let chordType = 'major';
        
        if (measure === 0) {
            rootFreq = SCALE.DO;
            chordType = 'major';
        } else if (measure === 1) {
            rootFreq = SCALE.SO / 2; // G
            chordType = 'major';
        } else if (measure === 2) {
            rootFreq = SCALE.LA / 2; // Am
            chordType = 'minor';
        } else if (measure === 3) {
            rootFreq = SCALE.FA / 2; // F
            chordType = 'major';
        }
        
        // ベース音を拍の頭に小さく鳴らす (ルート音の2オクターブ下)
        playBass(nextBeatTime, rootFreq / 4);
        
        // 伴奏和音を裏拍にさらに小さく鳴らす (ルート音の1オクターブ下を基準)
        playChord(nextBeatTime + BEAT_INTERVAL / 2, rootFreq / 2, chordType);
        
        if (nextEventType === 'hole') {
            // 穴のターゲット(ジャストタイミング)から逆算して予兆を鳴らす（ファ・ミ・レ・ド）
            // ドのタイミングでジャンプするように修正
            if (currentBeatCount === targetBeat - 3) playCueSound(nextBeatTime, SCALE.FA);
            if (currentBeatCount === targetBeat - 2) playCueSound(nextBeatTime, SCALE.MI);
            if (currentBeatCount === targetBeat - 1) playCueSound(nextBeatTime, SCALE.RE);
            if (currentBeatCount === targetBeat) playCueSound(nextBeatTime, SCALE.DO);
            
            // 穴を生成するタイミング：到達する時間の 4ビート前
            if (currentBeatCount === targetBeat - 4) {
                const targetHitTime = nextBeatTime + (4 * BEAT_INTERVAL);
                obstacles.push({ scrollSpeed: SCROLL_SPEED,
                    type: 'hole',
                    x: CANVAS_WIDTH,
                    width: 140, // 少し奥に伸ばす（元131、150だと早めのジャンプで落ちるため微調整）
                    targetHitTime: targetHitTime,
                    hit: false,
                    passed: false
                });
            }
        } else if (nextEventType === 'bird') {
            // 鳥のターゲットから逆算して予兆を鳴らす（ドレミファソ）
            if (currentBeatCount === targetBeat - 2) {
                playCueSound(nextBeatTime, SCALE.DO);
                playCueSound(nextBeatTime + BEAT_INTERVAL / 2, SCALE.RE); // 裏拍
            }
            if (currentBeatCount === targetBeat - 1) {
                playCueSound(nextBeatTime, SCALE.MI);
                playCueSound(nextBeatTime + BEAT_INTERVAL / 2, SCALE.FA); // 裏拍
            }
            if (currentBeatCount === targetBeat) {
                // ジャストタイミングでバックグラウンドで「ソ」を鳴らす
                playCueSound(nextBeatTime, SCALE.SO);
            }
            
            // 鳥を生成するタイミング：到達する時間の 4ビート前
            if (currentBeatCount === targetBeat - 4) {
                const targetHitTime = nextBeatTime + (4 * BEAT_INTERVAL);
                obstacles.push({ scrollSpeed: SCROLL_SPEED,
                    type: 'bird',
                    x: CANVAS_WIDTH,
                    width: 40,
                    targetHitTime: targetHitTime,
                    hit: false,
                    passed: false
                });
            }
        } else if (nextEventType === 'cactus') {
            // サボテン2個：予兆「ドレミレド」全4分音符
            // ミ（3音目、targetBeat-2）で1個目ジャンプ、ド（5音目、targetBeat）で2個目ジャンプ
            if (currentBeatCount === targetBeat - 4) playCueSound(nextBeatTime, SCALE.DO);
            if (currentBeatCount === targetBeat - 3) playCueSound(nextBeatTime, SCALE.RE);
            if (currentBeatCount === targetBeat - 2) playCueSound(nextBeatTime, SCALE.MI); // ← 1回目ジャンプ
            if (currentBeatCount === targetBeat - 1) playCueSound(nextBeatTime, SCALE.RE);
            if (currentBeatCount === targetBeat)     playCueSound(nextBeatTime, SCALE.DO); // ← 2回目ジャンプ
            
            // ギミック生成は5拍前（targetBeat-4のキュー音と同じタイミング）
            if (currentBeatCount === targetBeat - 5) {
                // サボテン1個目：targetBeat-2（ミのタイミング）に到達
                obstacles.push({ scrollSpeed: SCROLL_SPEED,
                    type: 'cactus', x: CANVAS_WIDTH, width: 30,
                    targetHitTime: nextBeatTime + (3 * BEAT_INTERVAL), hit: false, passed: false
                });
                // サボテン2個目：targetBeat（ドのタイミング）に到達
                obstacles.push({ scrollSpeed: SCROLL_SPEED,
                    type: 'cactus', x: CANVAS_WIDTH, width: 30,
                    targetHitTime: nextBeatTime + (5 * BEAT_INTERVAL), hit: false, passed: false
                });
            }
        } else if (nextEventType === 'cactus_bird') {
            // 予兆音「ファファミミレレドド」：4分音符のうち、最初が0.75拍、残りの0.25拍で2音目が鳴る（ハネるリズム）
            // 最後の1セット（ドド、表と裏）のタイミングで2回ジャンプ（ブロックを挟んだ連続ジャンプ）
            if (currentBeatCount === targetBeat - 3) {
                playCueSound(nextBeatTime, SCALE.FA);
                playCueSound(nextBeatTime + BEAT_INTERVAL * 0.75, SCALE.FA);
            }
            if (currentBeatCount === targetBeat - 2) {
                playCueSound(nextBeatTime, SCALE.MI);
                playCueSound(nextBeatTime + BEAT_INTERVAL * 0.75, SCALE.MI);
            }
            if (currentBeatCount === targetBeat - 1) {
                playCueSound(nextBeatTime, SCALE.RE);
                playCueSound(nextBeatTime + BEAT_INTERVAL * 0.75, SCALE.RE);
            }
            if (currentBeatCount === targetBeat) {
                playCueSound(nextBeatTime, SCALE.DO);
                playCueSound(nextBeatTime + BEAT_INTERVAL * 0.75, SCALE.DO);
            }
            
            // ギミック生成は 4拍前
            if (currentBeatCount === targetBeat - 4) {
                const baseHitTime = nextBeatTime + (4 * BEAT_INTERVAL); // ドの表（1回目ジャンプ）
                
                // 1. サボテン (ドの表に到達)
                obstacles.push({ scrollSpeed: SCROLL_SPEED,
                    type: 'cactus', x: CANVAS_WIDTH, width: 30,
                    targetHitTime: baseHitTime, hit: false, passed: false, parentType: 'cactus_bird'
                });
                
                // 2. 着地用ブロック (手前を10px、奥を20px小さく調整し、さらに後ろ側を10px長く: width: 60, forceOffset: -20)
                obstacles.push({ scrollSpeed: SCROLL_SPEED,
                    type: 'stairs', step: 1, height: 65, x: CANVAS_WIDTH, width: 60,
                    targetHitTime: baseHitTime + (0.75 * BEAT_INTERVAL), hit: true, passed: false, forceOffset: -20, parentType: 'cactus_bird'
                });
                
                // 3. 高い鳥 (ドの裏 0.75拍後に到達。少し後ろに移動: offsetDelay: 0.06)
                obstacles.push({ scrollSpeed: SCROLL_SPEED,
                    type: 'bird', high: true, offsetDelay: 0.06, x: CANVAS_WIDTH, width: 40,
                    targetHitTime: baseHitTime + (0.75 * BEAT_INTERVAL), hit: false, passed: false, parentType: 'cactus_bird'
                });
            }
        } else if (nextEventType === 'cactus_triplet') {
            // 予兆音：「ミレドミレド」3連符x2
            // 2セット目の3連符の最後の「ド」（targetBeat - 1 + 2/3拍の位置）でジャンプしてサボテンを避ける
            if (currentBeatCount === targetBeat - 2) {
                const subInterval = BEAT_INTERVAL / 3;
                playCueSound(nextBeatTime, SCALE.MI, subInterval * 0.8);
                playCueSound(nextBeatTime + subInterval, SCALE.RE, subInterval * 0.8);
                playCueSound(nextBeatTime + subInterval * 2, SCALE.DO, subInterval * 0.8);
            }
            if (currentBeatCount === targetBeat - 1) {
                const subInterval = BEAT_INTERVAL / 3;
                playCueSound(nextBeatTime, SCALE.MI, subInterval * 0.8);
                playCueSound(nextBeatTime + subInterval, SCALE.RE, subInterval * 0.8);
                playCueSound(nextBeatTime + subInterval * 2, SCALE.DO, subInterval * 0.8); // ← ここでジャンプ
            }
            
            // ギミック生成は 4拍前
            if (currentBeatCount === targetBeat - 4) {
                // 最後の「ド」の到達時間：targetBeatの頭から1/3拍前 (2セット目の最後のドの位置)
                const baseHitTime = nextBeatTime + (4 * BEAT_INTERVAL) - (BEAT_INTERVAL / 3); 
                obstacles.push({ scrollSpeed: SCROLL_SPEED,
                    type: 'cactus', x: CANVAS_WIDTH, width: 30,
                    targetHitTime: baseHitTime, hit: false, passed: false, parentType: 'cactus_triplet'
                });
            }
        } else if (nextEventType === 'single_spike') {
            // トゲ単体の予兆（ドドソソララソ、全て8分音符）
            if (currentBeatCount === targetBeat - 3) {
                playCueSound(nextBeatTime, SCALE.DO);
                playCueSound(nextBeatTime + BEAT_INTERVAL / 2, SCALE.DO);
            }
            if (currentBeatCount === targetBeat - 2) {
                playCueSound(nextBeatTime, SCALE.SO);
                playCueSound(nextBeatTime + BEAT_INTERVAL / 2, SCALE.SO);
            }
            if (currentBeatCount === targetBeat - 1) {
                playCueSound(nextBeatTime, SCALE.LA);
                playCueSound(nextBeatTime + BEAT_INTERVAL / 2, SCALE.LA);
            }
            if (currentBeatCount === targetBeat) {
                playCueSound(nextBeatTime, SCALE.SO); // 最後のソ、ここでジャンプ
            }
            
            // トゲ単体を生成するタイミング：到達する時間の 4ビート前
            if (currentBeatCount === targetBeat - 4) {
                const baseHitTime = nextBeatTime + (4 * BEAT_INTERVAL); // 最後のソ(targetBeat)のタイミング
                
                // ジャンプ滞空時間(0.6秒想定)の 0.25〜0.6 に配置
                // 到達遅延 = 0.15秒 (0.6 * 0.25)、終了 = 0.36秒 (0.6 * 0.6)
                // 幅の時間 = 0.21秒 -> 350px/s * 0.21 = 73.5 -> 74px
                // 到達遅延のオフセット = 350px/s * 0.15 = 52.5 -> 53px
                
                // targetHitTime はリズムのジャストタイミング(baseHitTime)に設定し、
                // 物理的な配置のズレは forceOffset で調整します。
                obstacles.push({ scrollSpeed: SCROLL_SPEED,
                    type: 'spike', x: CANVAS_WIDTH, width: 68,
                    targetHitTime: baseHitTime, hit: false, passed: false, forceOffset: 53
                });
            }
        } else if (nextEventType === 'triple_jump') {
            // ドドレレミミファファミレド
            if (currentBeatCount === targetBeat - 6) {
                playCueSound(nextBeatTime, SCALE.DO);
                playCueSound(nextBeatTime + BEAT_INTERVAL / 2, SCALE.DO);
            }
            if (currentBeatCount === targetBeat - 5) {
                playCueSound(nextBeatTime, SCALE.RE);
                playCueSound(nextBeatTime + BEAT_INTERVAL / 2, SCALE.RE);
            }
            if (currentBeatCount === targetBeat - 4) {
                playCueSound(nextBeatTime, SCALE.MI);
                playCueSound(nextBeatTime + BEAT_INTERVAL / 2, SCALE.MI);
            }
            if (currentBeatCount === targetBeat - 3) {
                playCueSound(nextBeatTime, SCALE.FA);
                playCueSound(nextBeatTime + BEAT_INTERVAL / 2, SCALE.FA);
            }
            if (currentBeatCount === targetBeat - 2) playCueSound(nextBeatTime, SCALE.MI);
            if (currentBeatCount === targetBeat - 1) playCueSound(nextBeatTime, SCALE.RE);
            if (currentBeatCount === targetBeat) playCueSound(nextBeatTime, SCALE.DO);
            
            // ギミック生成は 6拍前
            if (currentBeatCount === targetBeat - 6) {
                // 1回目のジャンプのタイミング (ミ)
                const baseHitTime = nextBeatTime + (4 * BEAT_INTERVAL);
                
                // 1. 穴
                obstacles.push({ scrollSpeed: SCROLL_SPEED,
                    type: 'hole', x: CANVAS_WIDTH, width: 131,
                    targetHitTime: baseHitTime, hit: false, passed: false, forceOffset: 0
                });
                
                // 2. 1段ブロック (さらに狭く: 50px)
                // 終了位置は 131 + 50 = 181px
                obstacles.push({ scrollSpeed: SCROLL_SPEED,
                    type: 'stairs', step: 1, x: CANVAS_WIDTH, width: 50,
                    targetHitTime: baseHitTime + (0.75 * BEAT_INTERVAL), hit: true, passed: false, forceOffset: 0
                });
                
                // 3. トゲ1 (地面)
                // ブロック終了直後(181px)から開始し、空白を埋める
                // targetHitTimeは 1.0拍(175px) なので、オフセットは 181 - 175 = 6px
                // 幅は 120px
                obstacles.push({ scrollSpeed: SCROLL_SPEED,
                    type: 'spike', x: CANVAS_WIDTH, width: 120,
                    targetHitTime: baseHitTime + (1.0 * BEAT_INTERVAL), hit: false, passed: false, forceOffset: 6
                });
                
                // 4. 2段ブロック (さらに狭く: 55px)
                // トゲ1の終了は 181 + 120 = 301px。 (301 / 175 = 約1.72拍)
                // 終了位置は 301 + 55 = 356px
                obstacles.push({ scrollSpeed: SCROLL_SPEED,
                    type: 'stairs', step: 2, x: CANVAS_WIDTH, width: 55,
                    targetHitTime: baseHitTime + (1.72 * BEAT_INTERVAL), hit: true, passed: false, forceOffset: 0
                });
                
                // 5. トゲ2 (地面)
                // ブロック終了直後(356px)から開始し、空白を埋める
                // targetHitTimeは 2.0拍(350px) なので、オフセットは 356 - 350 = 6px
                // 幅は 120px
                obstacles.push({ scrollSpeed: SCROLL_SPEED,
                    type: 'spike', x: CANVAS_WIDTH, width: 120,
                    targetHitTime: baseHitTime + (2.0 * BEAT_INTERVAL), hit: false, passed: false, forceOffset: 6
                });
            }
        } else if (nextEventType === 'stairs') {
            // 階段の予兆（ド・ド・ド・ソ・ソ）を一オクターブ低く
            if (currentBeatCount === targetBeat - 3) {
                playCueSound(nextBeatTime, SCALE.DO / 2);
            }
            if (currentBeatCount === targetBeat - 2) {
                playCueSound(nextBeatTime, SCALE.DO / 2);
                playCueSound(nextBeatTime + BEAT_INTERVAL / 2, SCALE.DO / 2);
            }
            if (currentBeatCount === targetBeat - 1) {
                playCueSound(nextBeatTime, SCALE.SO / 2);
            }
            if (currentBeatCount === targetBeat) {
                playCueSound(nextBeatTime, SCALE.SO / 2);
            }
            
            // 階段を生成するタイミング：到達する時間の 4ビート前
            if (currentBeatCount === targetBeat - 4) {
                const baseHitTime = nextBeatTime + (3 * BEAT_INTERVAL); // 基準点(最初のジャンプ)
                
                // 1. 穴： 基準点から始まり、3/4拍分 (175 * 0.75 = 131px)
                obstacles.push({ scrollSpeed: SCROLL_SPEED,
                    type: 'hole', x: CANVAS_WIDTH, width: 131,
                    targetHitTime: baseHitTime, hit: false, passed: false, forceOffset: 0
                });
                
                // 2. 箱： 穴の直後(3/4拍後)から始まり、1/4拍分 (175 * 0.25 = 44px)
                // ※ 箱の後ろを16分音符分(1/4拍)短くしました。
                obstacles.push({ scrollSpeed: SCROLL_SPEED,
                    type: 'stairs', step: 1, x: CANVAS_WIDTH, width: 44,
                    targetHitTime: baseHitTime + (0.75 * BEAT_INTERVAL), hit: true, passed: false, forceOffset: 0
                });
                
                // 3. トゲ： 箱の直後(1.0拍後 = 最後の「ソ」の瞬間)から始まり、3/4拍分 (175 * 0.75 = 131px)
                // 箱が短くなった分、開始位置が前倒しになり幅が広がります。
                obstacles.push({ scrollSpeed: SCROLL_SPEED,
                    type: 'spike', x: CANVAS_WIDTH, width: 131,
                    targetHitTime: baseHitTime + (1.0 * BEAT_INTERVAL), hit: false, passed: false, forceOffset: 0
                });
            }
        }

        // 次のターゲットの決定（ジャンプするビートを過ぎたら次を決める）
        if (currentBeatCount === targetBeat) {
            // スピードアップの予約がある場合、画面上の障害物が消えるのを待ってから発動させる
            if (isSpeedUpPending) {
                if (obstacles.length > 0) {
                    // まだ画面に障害物が残っている場合は待機（休符）
                    targetBeat = currentBeatCount + 1; // 次のビートで再確認
                    nextEventType = 'rest';
                } else {
                    // 全ての障害物が左に流れ切ったらスピードアップ発動
                    isSpeedUpPending = false;
                    speedUpPhase = 1;
                    speedUpStartTime = audioCtx.currentTime;
                    // 次のギミックが生成されないようにターゲットを十分に遅らせる
                    const restBeats = Math.ceil(1.0 / BEAT_INTERVAL) + 4;
                    targetBeat = currentBeatCount + restBeats;
                    // 休符中は予兆音が鳴らないようにダミーのイベントタイプを設定する
                    nextEventType = 'rest';
                }
            } else {
                // 障害物の種類をランダムに決定
                nextEventType = eventTypes[Math.floor(Math.random() * eventTypes.length)];

                // ランダムな余白を 0〜1拍 に減らしてテンポアップ
                const randomRest = Math.floor(Math.random() * 2); 
                
                // イベントの生成タイミングに合わせて必要最低限のビート数を設定
                let minInterval = 5;
                if (nextEventType === 'triple_jump') {
                    minInterval = 7; // -6拍前から生成するため
                } else if (nextEventType === 'cactus') {
                    minInterval = 6; // -5拍前から生成するため
                } else if (nextEventType === 'cactus_bird') {
                    minInterval = 5; // -4拍前から生成するため
                } else if (nextEventType === 'cactus_triplet') {
                    minInterval = 5; // -4拍前から生成するため
                }
                
                targetBeat = currentBeatCount + minInterval + randomRest;
            }
        }

        nextBeatTime += BEAT_INTERVAL;
        currentBeatCount++;
    }
    
    scheduleTimeout = setTimeout(scheduleAudioAndGameEvents, lookahead * 1000);
}

// ドラム音
function playKick(time) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(masterGain);
    
    osc.frequency.setValueAtTime(120, time);
    osc.frequency.exponentialRampToValueAtTime(0.01, time + 0.3);
    
    // キック音を0.5倍 (0.3 -> 0.15)
    gain.gain.setValueAtTime(0.15, time);
    gain.gain.exponentialRampToValueAtTime(0.01, time + 0.3);
    
    osc.start(time);
    osc.stop(time + 0.3);
}

// BGMベース音
function playBass(time, freq) {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(masterGain);
    
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, time);
    
    // 音ゲーの邪魔にならないよう音量は控えめに (60%に下げる: 0.04 -> 0.024)
    gain.gain.setValueAtTime(0.024, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.2);
    
    osc.start(time);
    osc.stop(time + 0.2);
}

// BGM和音（裏拍のチャッという音）
function playChord(time, rootFreq, type = 'major') {
    if (!audioCtx) return;
    // 純正律に基づく簡単な周波数比 (Major: 1, 5/4, 3/2 | Minor: 1, 6/5, 3/2)
    const freqs = type === 'major' 
        ? [rootFreq, rootFreq * 1.25, rootFreq * 1.5] 
        : [rootFreq, rootFreq * 1.2, rootFreq * 1.5];
        
    freqs.forEach(f => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(masterGain);
        
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(f, time);
        
        // 音量はさらに控えめに（和音なので3つ重なる）(60%に下げる: 0.015 -> 0.009)
        gain.gain.setValueAtTime(0.009, time);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.15);
        
        osc.start(time);
        osc.stop(time + 0.15);
    });
}

// 予兆音（トントントン・木琴風）
function playCueSound(time, freq = SCALE.NORMAL, duration = 0.15) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(masterGain);
    
    osc.type = 'triangle'; // 木琴のような丸くてアタックのある音
    osc.frequency.setValueAtTime(freq, time);
    
    gain.gain.setValueAtTime(0.4, time);
    gain.gain.exponentialRampToValueAtTime(0.01, time + duration);
    
    osc.start(time);
    osc.stop(time + duration);
}

function playJumpSound() {
    if(!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(masterGain);
    
    osc.type = 'sine';
    osc.frequency.setValueAtTime(400, audioCtx.currentTime);
    osc.frequency.linearRampToValueAtTime(600, audioCtx.currentTime + 0.1);
    
    gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
    gain.gain.linearRampToValueAtTime(0.01, audioCtx.currentTime + 0.1);
    
    osc.start();
    osc.stop(audioCtx.currentTime + 0.1);
}

function playMissSound() {
    if(!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(masterGain);
    
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(150, audioCtx.currentTime);
    osc.frequency.linearRampToValueAtTime(100, audioCtx.currentTime + 0.2);
    
    gain.gain.setValueAtTime(0.5, audioCtx.currentTime);
    gain.gain.linearRampToValueAtTime(0.01, audioCtx.currentTime + 0.2);
    
    osc.start();
    osc.stop(audioCtx.currentTime + 0.2);
}

// --- 入力と判定 ---
function handleInput(e) {
    if (isGameOver) {
        if (e.code === 'Enter') {
            e.preventDefault(); // デフォルト動作を防ぐ
            showStartScreen();
        }
        return;
    }
    if (!isPlaying) {
        return;
    }
    
    if (e.code === 'Space') {
        e.preventDefault();
        
        // ジャンプ（実際に飛べた場合のみ音を鳴らす）
        const jumped = player.jump();
        if (jumped) playJumpSound();
        
        const timeNow = audioCtx.currentTime;
        
        // 最も近い未判定の障害物を探す
        let targetObstacle = null;
        for (let obs of obstacles) {
            if (!obs.hit && !obs.passed) {
                targetObstacle = obs;
                break;
            }
        }
        
        if (targetObstacle) {
            const diff = Math.abs(timeNow - targetObstacle.targetHitTime);
            
            if (diff <= TIMING_PERFECT) {
                targetObstacle.hit = true;
                pendingJudgements.push({ type: 'PERFECT', diff: diff });
            } else if (diff <= TIMING_GOOD) {
                targetObstacle.hit = true;
                pendingJudgements.push({ type: 'GOOD', diff: diff });
            } else {
                // 早すぎた場合などはMiss扱いにしない（ジャンプしただけ）
                // 実際に落下してミスになる判定はupdateループ内で行う
            }
        }
    }
}

function addJudgement(text, color) {
    judgements.push({
        text: text,
        color: color,
        y: player.y - 20,
        alpha: 1.0,
        life: 60 // フレーム数
    });
}

function gameOver() {
    isGameOver = true;
    isPlaying = false;
    playMissSound();
    player.color = '#ff0000'; // やられ色
}

// --- メインループ ---
let lastTime = 0;

function gameLoop(timestamp) {
    if (!lastTime) lastTime = timestamp;
    const deltaTime = (timestamp - lastTime) / 1000; // 秒
    lastTime = timestamp;
    
    update(deltaTime);
    drawFrame();
    
    if (isPlaying || isGameOver) {
        animationId = requestAnimationFrame(gameLoop);
    }
}

// 矩形衝突判定（AABB）判定を緩くするマージン付き
function isColliding(rect1, rect2, marginX = 8, marginY = 8) {
    return rect1.x + marginX < rect2.x + rect2.width &&
           rect1.x + rect1.width - marginX > rect2.x &&
           rect1.y + marginY < rect2.y + rect2.height &&
           rect1.y + rect1.height - marginY > rect2.y;
}

function update(deltaTime) {
    if (isGameOver) {
        // ゲームオーバー後もプレイヤーの落下アニメーションだけは続ける
        player.update(CANVAS_HEIGHT + 200);
        return;
    }
    
    const timeNow = audioCtx ? audioCtx.currentTime : 0;
    
    // デバッグ用自動ジャンプは無効化されました
    
    // エフェクト終了判定
    if (activeEffect && timeNow > effectEndTime) {
        activeEffect = null;
    }
    
    // スピードアップ速度反映処理
    if (speedUpPhase === 1 && timeNow > speedUpStartTime + 1.0) {
        speedUpPhase = 0; // 平常に移行
        // 0.125倍（元の1/8）ずつ加算、ただし最大3.0倍まで
        speedMultiplier = Math.min(speedMultiplier + 0.125, 3.0);
        
        BPM = 120 * speedMultiplier;
        BEAT_INTERVAL = 60 / BPM;
        SCROLL_SPEED = 350 * speedMultiplier;
        player.jumpPower = -13 * speedMultiplier;
        player.gravity = 1.0 * speedMultiplier;
        
        // スピードに合わせて判定幅もシビアにする（飛距離のロスを一定に保つ）
        TIMING_PERFECT = 0.05 / speedMultiplier;
        TIMING_GOOD = 0.08 / speedMultiplier;
    }
    
    // 1. まず全障害物の位置を計算
    for (let i = 0; i < obstacles.length; i++) {
        let obs = obstacles[i];
        const timeUntilHit = obs.targetHitTime - timeNow;
        // ギミック生成時のスクロール速度を使用する（SPEED UP時に過去のギミックがズレないようにするため）
        const currentObsScrollSpeed = obs.scrollSpeed || SCROLL_SPEED;
        
        let offset = 0;
        const JUMP_FRAMES = 2 * Math.abs(player.jumpPower) / player.gravity;
        const JUMP_DURATION = JUMP_FRAMES / 60; // 滞空時間(秒)
        
        if (obs.type === 'bird' || obs.type === 'cactus') {
            const delay = obs.offsetDelay || 0;
            const PEAK_TIME = JUMP_DURATION / 2 + delay;
            offset = (player.width / 2) - (obs.width / 2) + (PEAK_TIME * currentObsScrollSpeed);
        } else if (obs.type === 'stairs' || obs.type === 'spike') {
            const OFFSET_TIME = JUMP_DURATION * 0.75;
            offset = (player.width / 2) - (obs.width / 2) + (OFFSET_TIME * currentObsScrollSpeed);
        }
        
        // forceOffset が指定されている場合はそちらを優先（精密配置用）
        if (obs.forceOffset !== undefined) {
            offset = obs.forceOffset;
        }
        
        obs.offset = offset; // 後の判定で使うために保存
        obs.x = PLAYER_X + (timeUntilHit * currentObsScrollSpeed) + offset;
    }
    
    const wasJumping = player.isJumping;
    let currentFloorY = GROUND_Y;
    let inHole = false;
    for (let i = 0; i < obstacles.length; i++) {
        let obs = obstacles[i];
        if (obs.type === 'stairs') {
            const height = obs.height !== undefined ? obs.height : (obs.step === 1 ? 40 : 80);
            const blockTop = GROUND_Y - height;
            const marginX = 8;
            // プレイヤーとブロックのX座標が重なっているか
            if (player.x + player.width - marginX > obs.x && player.x + marginX < obs.x + obs.width) {
                // プレイヤーの足がブロックの上面以上（少し食い込むのも許容）なら乗れる
                if (player.y + player.height <= blockTop + 20) {
                    currentFloorY = blockTop;
                }
            }
        } else if (obs.type === 'hole') {
            // Good判定の有効期間内（かつ未判定）なら、まだジャンプする猶予があるので穴に落とさない
            if (!obs.hit && timeNow < obs.targetHitTime + TIMING_GOOD) {
                continue;
            }
            // 足元が穴かどうか（プレイヤーの幅の大部分が穴の中にあるか）
            const marginX = 10;
            if (player.x + player.width - marginX > obs.x && player.x + marginX < obs.x + obs.width) {
                // 地面にいる、または落下してきて地面を突き抜けそうなとき
                if (player.y + player.height >= GROUND_Y - 5) {
                    inHole = true;
                }
            }
        }
    }
    
    if (inHole) {
        currentFloorY = CANVAS_HEIGHT + 200; // 底なし穴
    }
    
    // 3. プレイヤーの位置更新（床の高さを渡す）
    player.update(currentFloorY);
    
    // 着地判定フラグを保存
    let justLanded = (wasJumping && !player.isJumping);
    
    // もし地面より下に落ちたら穴に落ちた判定（ゲームオーバー）
    if (player.y + player.height > GROUND_Y + 10) {
        combo = 0;
        addJudgement('MISS...', '#555');
        gameOver();
    }
    
    // 4. 判定処理（更新後のプレイヤー位置で判定）
    for (let i = 0; i < obstacles.length; i++) {
        let obs = obstacles[i];
        
        // 物理的な当たり判定（鳥・トゲ・ブロックの横衝突・サボテン）
        if (obs.type === 'bird' || obs.type === 'spike' || obs.type === 'stairs' || obs.type === 'cactus') {
            // すでにタイミング判定成功(hit)しているか、またはGood判定の有効期間内の障害物（stairs以外）は衝突を免除する
            if ((obs.hit || (!obs.passed && timeNow < obs.targetHitTime + TIMING_GOOD)) && obs.type !== 'stairs') continue;
            
            let height, y;
            let marginX = 8;
            let marginY = 8;
            
            if (obs.type === 'stairs') {
                height = obs.height !== undefined ? obs.height : (obs.step === 1 ? 40 : 80);
                y = GROUND_Y - height;
                // ブロックの上に乗っている状態（floorYがblockTop）なら衝突無視
                if (currentFloorY === y) continue;
            } else if (obs.type === 'bird') {
                height = 40;
                y = obs.high ? (GROUND_Y - 88) : (GROUND_Y - 50);
            } else if (obs.type === 'spike') {
                height = 20;
                y = obs.onStairs ? (GROUND_Y - 40 - height) : (GROUND_Y - height);
                // トゲも当たり判定を厳しく（すり抜けにくく）する
                marginX = 4;
                marginY = 2;
            } else if (obs.type === 'cactus') {
                height = 50;
                y = GROUND_Y - height;
                // サボテンは細いので判定を厳しめに（当たりやすく）する
                marginX = 2;
                marginY = 2;
            }
            const obsRect = { x: obs.x, y: y, width: obs.width, height: height };
            
            if (isColliding(player, obsRect, marginX, marginY)) {
                // コンボ成功(hit)している障害物でも、物理的にぶつかったらアウト
                // ただし、もしhit済みの場合は二重にMiss判定処理などを呼ばないようにする工夫も可能だが
                // gameOverになるので同じこと
                combo = 0;
                addJudgement('MISS...', '#555');
                gameOver();
            }
        }
        
        // 2. 判定漏れチェック（ジャンプせずに通り過ぎてしまった場合など）
        const passDelay = 0.1 + ((obs.offset || 0) / SCROLL_SPEED);
        if (!obs.hit && !obs.passed && timeNow > obs.targetHitTime + passDelay) {
            obs.passed = true;
            obs.hit = true;
            
            // 穴以外のオブジェクトを超えてヒットしていなければ全てGOODとみなす
            combo = 0; // GOODなのでコンボリセット
            const bonus = getComboBonus(combo);
            score += 50 + (bonus / 2);
            score = Math.floor(score);
            addJudgementPos('GOOD', '#05d9e8', player.y - 20);
        }
    }
    
    // 着地後、MISS（ゲームオーバー）でなければジャンプ判定（GOOD/PERFECT）を出力する
    if (justLanded && !isGameOver) {
        processPendingJudgements(timeNow);
    }

    // 画面外に出た障害物を消す
    obstacles = obstacles.filter(obs => obs.x + obs.width > 0);
    
    // 判定エフェクトの更新
    for (let i = judgements.length - 1; i >= 0; i--) {
        judgements[i].life--;
        judgements[i].y -= 0.5;
        judgements[i].alpha = judgements[i].life / 60;
        if (judgements[i].life <= 0) {
            judgements.splice(i, 1);
        }
    }
}

function drawFrame() {
    ctx.save();
    
    // 逆さまエフェクト
    if (activeEffect === 'inverted') {
        ctx.translate(CANVAS_WIDTH, CANVAS_HEIGHT);
        ctx.scale(-1, -1);
    }

    // 背景クリア
    ctx.fillStyle = '#f7f7f7';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    
    // 地面の線
    ctx.beginPath();
    ctx.moveTo(0, GROUND_Y);
    ctx.lineTo(CANVAS_WIDTH, GROUND_Y);
    ctx.strokeStyle = '#535353';
    ctx.lineWidth = 2;
    ctx.stroke();
    
    // 障害物（落とし穴）の描画
    for (let obs of obstacles) {
        if (obs.type === 'hole') {
            const offset = 15;
            // 地面に穴をあける表現（白で塗って、下に模様をつける）
            ctx.fillStyle = '#f7f7f7'; // 背景色と同じにして線を消す
            ctx.fillRect(obs.x + offset, GROUND_Y - 2, obs.width - offset, 4);
            
            // 穴の中
            ctx.fillStyle = '#333';
            ctx.fillRect(obs.x + offset, GROUND_Y, obs.width - offset, 100); // 下まで塗る
        } else if (obs.type === 'bird') {
            // 鳥の描画（空飛ぶ三角形のシルエット、少し高め）
            const baseY = obs.high ? (GROUND_Y - 88) : (GROUND_Y - 50);
            ctx.fillStyle = '#535353';
            ctx.beginPath();
            ctx.moveTo(obs.x, baseY); // 胴体下部
            ctx.lineTo(obs.x + obs.width, baseY); // 胴体下部後方
            ctx.lineTo(obs.x + obs.width / 2, baseY - 20); // 上の翼
            ctx.fill();
            
            // 目
            ctx.fillStyle = '#fff';
            ctx.fillRect(obs.x + 5, baseY - 5, 4, 4);
        } else if (obs.type === 'stairs') {
            // 階段の描画（濃いグレーのブロック）
            ctx.fillStyle = '#666';
            const height = obs.height !== undefined ? obs.height : (obs.step === 1 ? 40 : 80);
            ctx.fillRect(obs.x, GROUND_Y - height, obs.width, height);
            
            // ブロックっぽい模様（枠線と×印）
            ctx.strokeStyle = '#333';
            ctx.lineWidth = 2;
            ctx.strokeRect(obs.x, GROUND_Y - height, obs.width, height);
            
            ctx.beginPath();
            ctx.moveTo(obs.x, GROUND_Y - height);
            ctx.lineTo(obs.x + obs.width, GROUND_Y);
            ctx.moveTo(obs.x + obs.width, GROUND_Y - height);
            ctx.lineTo(obs.x, GROUND_Y);
            ctx.stroke();
            
        } else if (obs.type === 'spike') {
            // トゲの描画（黒いギザギザ）
            ctx.fillStyle = '#535353';
            const baseY = obs.onStairs ? (GROUND_Y - 40) : GROUND_Y;
            ctx.beginPath();
            for (let j = 0; j < obs.width; j += 10) {
                ctx.moveTo(obs.x + j, baseY);
                ctx.lineTo(obs.x + j + 5, baseY - 20);
                ctx.lineTo(obs.x + j + 10, baseY);
            }
            ctx.fill();
        } else if (obs.type === 'cactus') {
            // サボテンの描画（ドット絵風シルエット）
            ctx.fillStyle = '#535353';
            
            // メインの幹
            ctx.fillRect(obs.x + 10, GROUND_Y - 50, 10, 50);
            // 左の枝
            ctx.fillRect(obs.x, GROUND_Y - 35, 10, 5);
            ctx.fillRect(obs.x, GROUND_Y - 45, 5, 10);
            // 右の枝
            ctx.fillRect(obs.x + 20, GROUND_Y - 25, 10, 5);
            ctx.fillRect(obs.x + 25, GROUND_Y - 35, 5, 10);
        }
    }
    
    // プレイヤー描画
    player.draw(ctx);
    
    // 暗闇エフェクト（UIの下に敷く）
    if (activeEffect === 'darkness') {
        const px = player.x + player.width / 2;
        const py = player.y + player.height / 2;
        
        const gradient = ctx.createRadialGradient(px, py, 40, px, py, 180);
        gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
        gradient.addColorStop(0.5, 'rgba(0, 0, 0, 0.8)');
        gradient.addColorStop(1, 'rgba(0, 0, 0, 1)');
        
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    }
    
    // UI（スコア、コンボなど）
    // 暗転時は文字を白にして視認性を確保
    ctx.fillStyle = activeEffect === 'darkness' ? '#ffffff' : '#535353';
    ctx.font = '16px "Press Start 2P"';
    ctx.textAlign = 'right';
    
    // SPEEDの表示（1.0より大きい場合のみ）
    if (speedMultiplier > 1.0) {
        let speedText = speedMultiplier >= 3.0 ? 'MAX' : 'x' + speedMultiplier.toFixed(3);
        ctx.textAlign = 'center';
        ctx.fillText(`SPEED: ${speedText}`, CANVAS_WIDTH / 2, 30);
    }
    
    ctx.textAlign = 'right';
    ctx.fillText(`SCORE: ${score.toString().padStart(6, '0')}`, CANVAS_WIDTH - 20, 30);
    
    if (combo > 1) {
        ctx.textAlign = 'left';
        ctx.fillText(`COMBO x${combo}`, 20, 30);
    }
    
    // 判定エフェクト描画
    ctx.textAlign = 'center';
    ctx.font = '20px "Press Start 2P"';
    for (let j of judgements) {
        ctx.fillStyle = j.color;
        ctx.globalAlpha = j.alpha;
        ctx.fillText(j.text, player.x + player.width/2, j.y);
        ctx.globalAlpha = 1.0; // 元に戻す
    }
    
    // SPEED UP エフェクト描画
    if (speedUpPhase === 1) {
        const elapsed = audioCtx.currentTime - speedUpStartTime;
        // 1秒かけて右から左へ (p: 0.0 -> 1.0)
        const p = Math.min(elapsed / 1.0, 1.0);
        const textX = CANVAS_WIDTH - (CANVAS_WIDTH + 400) * p + 200;
        
        ctx.fillStyle = '#ff2a6d';
        ctx.font = 'bold 50px "Press Start 2P"';
        ctx.textAlign = 'center';
        ctx.fillText('SPEED UP!!', textX, CANVAS_HEIGHT / 2);
    }
    
    ctx.restore();
    
    // ゲームオーバー表示（これは逆さまでも読めるようにrestore後に描画）
    if (isGameOver) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.font = '30px "Press Start 2P"';
        ctx.fillText('GAME OVER', CANVAS_WIDTH/2, CANVAS_HEIGHT/2 - 40);
        
        ctx.fillStyle = '#ff2a6d';
        ctx.font = '20px "Press Start 2P"';
        ctx.fillText(`SCORE: ${score}`, CANVAS_WIDTH/2, CANVAS_HEIGHT/2 + 10);
        
        ctx.fillStyle = '#fff';
        ctx.font = '14px "Press Start 2P"';
        ctx.fillText('PRESS ENTER TO RETURN TO TITLE', CANVAS_WIDTH/2, CANVAS_HEIGHT/2 + 60);
    }
}

function getComboBonus(currentCombo) {
    let bonus = 0;
    if (currentCombo <= 10) {
        bonus = currentCombo * 10;
    } else {
        bonus = 100 + Math.floor((currentCombo - 10) / 5) * 10;
    }
    return Math.min(bonus, 200);
}

function processPendingJudgements(timeNow) {
    if (pendingJudgements.length === 0) return;
    
    // まとめて処理
    let addedJudgements = 0;
    
    for (let p of pendingJudgements) {
        if (p.type === 'GOOD') {
            combo = 0; // GOODが出たらコンボはリセットされる
        }
        
        const bonus = getComboBonus(combo);
        
        if (p.type === 'PERFECT') {
            score += 100 + bonus;
            combo++;
            // 複数ある場合は表示位置を少しずつ上にずらす
            const yOffset = addedJudgements * 25;
            addJudgementPos('PERFECT!', '#ff2a6d', player.y - 20 - yOffset);
        } else if (p.type === 'GOOD') {
            // コンボはリセットされたのでボーナスは0になる
            score += 50 + (bonus / 2);
            const yOffset = addedJudgements * 25;
            addJudgementPos('GOOD', '#05d9e8', player.y - 20 - yOffset);
        }
        addedJudgements++;
    }
    
    score = Math.floor(score);
    pendingJudgements = []; // リセット
    
    // スコアが加算されたので、ここでSPEED UP判定を行う（3.0倍が上限）
    if (score >= nextSpeedUpScore && speedUpPhase === 0 && !isSpeedUpPending && speedMultiplier < 3.0) {
        isSpeedUpPending = true;
        if (nextSpeedUpScore >= 20000) {
            nextSpeedUpScore += 5000; // 20000点以降は5000点刻み
        } else {
            nextSpeedUpScore += 2500; // それ未満は2500点刻み
        }
    }
}

// 判定文字を指定Y座標に出すためのヘルパー
function addJudgementPos(text, color, yPos) {
    judgements.push({
        text: text,
        color: color,
        y: yPos,
        alpha: 1.0,
        life: 60 // フレーム数
    });
}

// 起動
init();
