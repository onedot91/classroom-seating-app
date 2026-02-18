
class AudioService {
  private ctx: AudioContext | null = null;

  private getCtx(): AudioContext | null {
    try {
      if (!this.ctx) {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioContextClass) {
            this.ctx = new AudioContextClass();
        }
      }
      
      // 모바일 브라우저 정책 대응: suspended 상태면 resume 시도
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      
      return this.ctx;
    } catch (e) {
      console.error("Audio initialization failed", e);
      return null;
    }
  }

  // 카운트다운 초당 비프음
  playCountdownTick() {
    try {
      const ctx = this.getCtx();
      if (!ctx) return;
      
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.1);
    } catch (e) {
      // 오디오 재생 실패해도 앱 로직은 계속되어야 함
    }
  }

  // 셔플 중 발생하는 소리
  playShuffleTick() {
    try {
      const ctx = this.getCtx();
      if (!ctx) return;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(Math.random() * 200 + 100, ctx.currentTime);
      gain.gain.setValueAtTime(0.03, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.005, ctx.currentTime + 0.05);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.05);
    } catch (e) {
    }
  }

  // 완료 시 재생되는 맑은 종소리
  playSuccess() {
    try {
      const ctx = this.getCtx();
      if (!ctx) return;

      const now = ctx.currentTime;
      const playNote = (freq: number, start: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0.15, start);
        gain.gain.exponentialRampToValueAtTime(0.01, start + 0.6);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.6);
      };
      playNote(523.25, now);
      playNote(659.25, now + 0.15);
      playNote(783.99, now + 0.3);
      playNote(1046.5, now + 0.45);
    } catch (e) {
    }
  }

  // 카메라 셔터음 느낌의 효과음
  playCapture() {
    try {
      const ctx = this.getCtx();
      if (!ctx) return;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1200, ctx.currentTime);
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.1);
    } catch (e) {
    }
  }

  // 저장 확인용 짧은 더블 비프음
  playSave() {
    try {
      const ctx = this.getCtx();
      if (!ctx) return;

      const now = ctx.currentTime;
      const playNote = (freq: number, start: number, dur: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0.08, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + dur);
      };
      playNote(660, now, 0.1);
      playNote(880, now + 0.08, 0.15);
    } catch (e) {
    }
  }

  // 기록 보기 등 일반적인 클릭음
  playClick() {
    try {
      const ctx = this.getCtx();
      if (!ctx) return;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1400, ctx.currentTime);
      gain.gain.setValueAtTime(0.05, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.05);
    } catch (e) {
    }
  }
}

export const audioService = new AudioService();
