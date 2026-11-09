import React, { useRef, useEffect, useState, useMemo } from 'react';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Rewind,
  FastForward,
  Volume2,
  VolumeX,
  Plus,
  Smartphone,
  Monitor,
  Square,
  Maximize2,
} from 'lucide-react';
import {
  CaptionTemplate,
  SubtitleSegment,
  VideoAspectRatio,
  VideoScaleMode,
  resolveFontFamilyCss,
  resolveFontWeightCss,
} from '../../shared/segment.schema';
import { formatTimestampHMS } from '../lib/srt';
import { appendAuthTokenToUrl } from '../lib/api';

interface VideoPlayerProps {
  videoUrl: string;
  durationSec: number;
  currentTime: number;
  segments: SubtitleSegment[];
  activeSegment: SubtitleSegment | null;
  template: CaptionTemplate;
  captionsVisible?: boolean;
  videoVisible?: boolean;
  onUpdateTemplate?: (patch: Partial<CaptionTemplate>) => void;
  onTimeUpdate: (time: number) => void;
  onDurationLoaded: (duration: number) => void;
  onAddSegmentAtCurrentTime: (time: number) => void;
  onSelectSegment?: (segId: string, time: number) => void;
  seekTrigger: { time: number; seq: number } | null;
}

const ASPECT_RATIO_OPTIONS: {
  id: VideoAspectRatio;
  label: string;
  badge: string;
}[] = [
  { id: 'original', label: 'Original', badge: 'Auto' },
  { id: '9:16', label: '9:16', badge: 'Reels/TikTok' },
  { id: '16:9', label: '16:9', badge: 'YouTube' },
  { id: '1:1', label: '1:1', badge: 'Square' },
  { id: '4:5', label: '4:5', badge: 'Portrait' },
  { id: '4:3', label: '4:3', badge: 'Classic' },
];

/**
 * Splits Khmer + English subtitle text into speakable word tokens for Karaoke & Word-by-Word modes
 */
function tokenizeForKaraoke(text: string): string[] {
  const trimmed = (text || '').trim();
  if (!trimmed) return [];
  const spaceParts = trimmed.split(/\s+/).filter(Boolean);
  if (spaceParts.length >= 2) {
    return spaceParts;
  }
  const chunks: string[] = [];
  const step = Math.max(4, Math.ceil(trimmed.length / 4));
  for (let i = 0; i < trimmed.length; i += step) {
    chunks.push(trimmed.slice(i, i + step));
  }
  return chunks;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  videoUrl,
  durationSec,
  currentTime,
  segments,
  activeSegment,
  template,
  captionsVisible = true,
  videoVisible = true,
  onUpdateTemplate,
  onTimeUpdate,
  onDurationLoaded,
  onAddSegmentAtCurrentTime,
  onSelectSegment,
  seekTrigger,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [videoError, setVideoError] = useState(false);
  const [naturalDim, setNaturalDim] = useState<{ width: number; height: number }>({
    width: 1920,
    height: 1080,
  });

  const selectedRatio: VideoAspectRatio = template.aspectRatio || 'original';
  const selectedScaleMode: VideoScaleMode = template.scaleMode || 'fit';

  // Resolve effective numeric aspect ratio
  const effectiveRatioKey = useMemo((): Exclude<VideoAspectRatio, 'original'> => {
    if (selectedRatio !== 'original') return selectedRatio;
    const { width, height } = naturalDim;
    if (height > width * 1.35) return '9:16';
    if (height > width * 1.08) return '4:5';
    if (Math.abs(width - height) <= width * 0.12) return '1:1';
    if (width / Math.max(1, height) < 1.5) return '4:3';
    return '16:9';
  }, [selectedRatio, naturalDim]);

  const frameBoxClasses = useMemo(() => {
    switch (effectiveRatioKey) {
      case '9:16':
        return 'aspect-[9/16] h-[420px] max-w-full';
      case '4:5':
        return 'aspect-[4/5] h-[400px] max-w-full';
      case '1:1':
        return 'aspect-square h-[380px] max-w-full';
      case '4:3':
        return 'aspect-[4/3] h-[360px] max-w-full';
      case '16:9':
      default:
        return 'aspect-video w-full max-h-[380px]';
    }
  }, [effectiveRatioKey]);

  const [resolvedVideoUrl, setResolvedVideoUrl] = useState<string>(videoUrl);

  useEffect(() => {
    let active = true;
    setVideoError(false);
    if (videoUrl && videoUrl.startsWith('/media/')) {
      appendAuthTokenToUrl(videoUrl).then((authUrl) => {
        if (active) setResolvedVideoUrl(authUrl);
      });
    } else {
      setResolvedVideoUrl(videoUrl);
    }
    return () => {
      active = false;
    };
  }, [videoUrl]);

  useEffect(() => {
    if (!seekTrigger) return;
    if (videoRef.current && !videoError) {
      videoRef.current.currentTime = seekTrigger.time;
    }
    onTimeUpdate(seekTrigger.time);
  }, [seekTrigger]);

  useEffect(() => {
    if (!videoError && resolvedVideoUrl) return;
    if (!isPlaying) return;
    const interval = window.setInterval(() => {
      onTimeUpdate(
        currentTime + 0.1 * playbackRate >= durationSec
          ? 0
          : currentTime + 0.1 * playbackRate
      );
    }, 100);
    return () => window.clearInterval(interval);
  }, [isPlaying, videoError, videoUrl, currentTime, durationSec, playbackRate]);

  const togglePlay = () => {
    const el = videoRef.current;
    if (!el || videoError || !videoUrl) {
      setIsPlaying((p) => !p);
      return;
    }
    if (el.paused) {
      el.play().catch(() => setIsPlaying(true));
      setIsPlaying(true);
    } else {
      el.pause();
      setIsPlaying(false);
    }
  };

  const skipSeconds = (delta: number) => {
    const target = Math.max(0, Math.min(durationSec || 18, currentTime + delta));
    if (videoRef.current && !videoError) {
      videoRef.current.currentTime = target;
    }
    onTimeUpdate(target);
  };

  const jumpToPreviousSubtitle = () => {
    if (segments.length === 0) return;
    const prev = [...segments]
      .reverse()
      .find((s) => s.start < currentTime - 0.3);
    const target = prev || segments[0];
    skipSeconds(target.start - currentTime);
    if (onSelectSegment) onSelectSegment(target.id, target.start);
  };

  const jumpToNextSubtitle = () => {
    if (segments.length === 0) return;
    const next = segments.find((s) => s.start > currentTime + 0.2);
    const target = next || segments[segments.length - 1];
    skipSeconds(target.start - currentTime);
    if (onSelectSegment) onSelectSegment(target.id, target.start);
  };

  const toggleMute = () => {
    if (videoRef.current) {
      videoRef.current.muted = !isMuted;
    }
    setIsMuted(!isMuted);
  };

  const setSpeed = (rate: number) => {
    setPlaybackRate(rate);
    if (videoRef.current) {
      videoRef.current.playbackRate = rate;
    }
  };

  const handleSelectAspectRatio = (ratio: VideoAspectRatio) => {
    if (onUpdateTemplate) {
      onUpdateTemplate({ aspectRatio: ratio });
    }
  };

  const handleSelectScaleMode = (mode: VideoScaleMode) => {
    if (onUpdateTemplate) {
      onUpdateTemplate({ scaleMode: mode });
    }
  };

  // Compute progress within the active subtitle segment (0 to 1)
  const segProgress = useMemo(() => {
    if (!activeSegment) return 0;
    const dur = Math.max(0.2, activeSegment.end - activeSegment.start);
    return Math.max(0, Math.min(1, (currentTime - activeSegment.start) / dur));
  }, [activeSegment, currentTime]);

  const tokens = useMemo(
    () => (activeSegment ? tokenizeForKaraoke(activeSegment.text) : []),
    [activeSegment?.text]
  );

  const activeWordIdx = useMemo(() => {
    if (tokens.length === 0) return -1;
    return Math.min(tokens.length - 1, Math.floor(segProgress * tokens.length));
  }, [tokens.length, segProgress]);

  const easingCss = useMemo(() => {
    switch (template.animationEasing) {
      case 'linear':
        return 'linear';
      case 'ease_in':
        return 'cubic-bezier(0.4, 0, 1, 1)';
      case 'ease_out':
        return 'cubic-bezier(0, 0, 0.2, 1)';
      case 'ease_in_out':
        return 'cubic-bezier(0.4, 0, 0.2, 1)';
      case 'overshoot':
        return 'cubic-bezier(0.34, 1.56, 0.64, 1)';
      case 'elastic':
        return 'cubic-bezier(0.68, -0.6, 0.32, 1.6)';
      case 'bounce':
        return 'cubic-bezier(0.34, 1.85, 0.64, 1)';
      default:
        return 'cubic-bezier(0.34, 1.56, 0.64, 1)';
    }
  }, [template.animationEasing]);

  // Entrance, Exit & Loop transform styles driven by Duration (s) and Easing
  const animationTransformStyle: React.CSSProperties = useMemo(() => {
    if (!activeSegment) return {};
    const segDur = Math.max(0.3, activeSegment.end - activeSegment.start);
    const inDur = Math.max(0.1, Math.min(segDur * 0.6, template.animationDuration ?? 0.4));
    const outDur = Math.max(0.1, Math.min(segDur * 0.5, template.outAnimationDuration ?? 0.3));
    const elapsed = Math.max(0, currentTime - activeSegment.start);
    const remaining = Math.max(0, activeSegment.end - currentTime);

    const isEntering = template.entranceAnimation !== 'none' && elapsed < inDur * 0.65;
    const isExiting =
      template.exitAnimation &&
      template.exitAnimation !== 'none' &&
      remaining < outDur * 0.65;

    const transitionStr = `transform ${Math.round(inDur * 650)}ms ${easingCss}, opacity ${Math.round(inDur * 550)}ms ${easingCss}, filter ${Math.round(inDur * 550)}ms ${easingCss}, clip-path ${Math.round(inDur * 650)}ms ${easingCss}`;

    if (isEntering) {
      switch (template.entranceAnimation) {
        case 'fade_in':
          return { opacity: 0.25, transition: transitionStr };
        case 'rise':
          return { transform: 'translateY(14px)', opacity: 0.35, transition: transitionStr };
        case 'slide_up':
          return { transform: 'translateX(-18px)', opacity: 0.4, transition: transitionStr };
        case 'slide_down':
          return { transform: 'translateY(-14px)', opacity: 0.4, transition: transitionStr };
        case 'pop':
          return { transform: 'scale(0.72)', opacity: 0.5, transition: transitionStr };
        case 'zoom':
        case 'scale_in':
          return { transform: 'scale(1.26)', opacity: 0.45, transition: transitionStr };
        case 'blur':
          return { filter: 'blur(6px)', opacity: 0.45, transition: transitionStr };
        case 'wipe':
          return {
            clipPath: 'inset(0 75% 0 0)',
            transition: transitionStr,
          };
        default:
          return { opacity: 0.95, transition: transitionStr };
      }
    }

    if (isExiting) {
      switch (template.exitAnimation) {
        case 'fade_out':
          return { opacity: 0.2, transition: transitionStr };
        case 'slide_down':
          return { transform: 'translateY(12px)', opacity: 0.25, transition: transitionStr };
        case 'pop_out':
        case 'scale_out':
          return { transform: 'scale(0.78)', opacity: 0.25, transition: transitionStr };
        case 'blur_out':
          return { filter: 'blur(6px)', opacity: 0.25, transition: transitionStr };
        case 'wipe_out':
          return { clipPath: 'inset(0 0 0 80%)', opacity: 0.3, transition: transitionStr };
        default:
          return { opacity: 0.85, transition: transitionStr };
      }
    }

    // Continuous Loop animations during steady state
    const loopType = template.loopAnimation || 'none';
    const loopPeriod = Math.max(0.3, template.loopAnimationDuration ?? 1.2);
    const phase = (currentTime % loopPeriod) / loopPeriod;
    const wave = Math.sin(phase * Math.PI * 2);

    if (loopType === 'pulse' || loopType === 'breathe') {
      const s = 1 + wave * (loopType === 'pulse' ? 0.05 : 0.03);
      return {
        transform: `scale(${s.toFixed(3)})`,
        opacity: 1,
        transition: 'transform 120ms linear',
      };
    }
    if (loopType === 'float' || loopType === 'wave') {
      const dy = wave * 4;
      return {
        transform: `translateY(${dy.toFixed(1)}px)`,
        opacity: 1,
        transition: 'transform 120ms linear',
      };
    }
    if (loopType === 'shake') {
      const dx = Math.sin(currentTime * 28) * 2.5;
      return {
        transform: `translateX(${dx.toFixed(1)}px)`,
        opacity: 1,
      };
    }

    return {
      transform: 'translateY(0) scale(1)',
      opacity: 1,
      filter: 'blur(0px)',
      clipPath: 'inset(0 0 0 0)',
      transition: transitionStr,
    };
  }, [
    activeSegment,
    currentTime,
    easingCss,
    template.entranceAnimation,
    template.exitAnimation,
    template.loopAnimation,
    template.animationDuration,
    template.outAnimationDuration,
    template.loopAnimationDuration,
  ]);

  // Position coordinates
  const positionContainerStyle: React.CSSProperties = useMemo(() => {
    if (template.position === 'custom') {
      const x = Math.max(10, Math.min(90, template.customX ?? 50));
      const y = Math.max(10, Math.min(92, template.customY ?? 85));
      return {
        left: `${x}%`,
        top: `${y}%`,
        transform: 'translate(-50%, -50%)',
      };
    }
    if (template.position === 'top') {
      return { left: '50%', top: '12%', transform: 'translateX(-50%)' };
    }
    if (template.position === 'middle') {
      return { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };
    }
    return { left: '50%', bottom: '8%', transform: 'translateX(-50%)' };
  }, [template.position, template.customX, template.customY]);

  const backgroundClass = useMemo(() => {
    switch (template.background) {
      case 'none':
        return 'bg-transparent px-2 py-1';
      case 'transparent':
        return 'bg-black/35 backdrop-blur-[1px] px-3.5 py-1.5 rounded';
      case 'box':
        return 'bg-black/80 px-4 py-1.5 rounded-none border border-white/10';
      case 'full_width':
        return 'bg-black/80 w-full px-6 py-2';
      case 'rounded':
      default:
        return 'bg-black/70 backdrop-blur-[2px] px-4 py-1.5 rounded-xl';
    }
  }, [template.background]);

  const textShadowStyle = useMemo(() => {
    const parts: string[] = [];
    if (template.outline > 0) {
      const o = Math.min(8, template.outline);
      parts.push(
        `0 0 ${o * 1.5}px #000`,
        `${o * 0.5}px ${o * 0.5}px 0 #000`,
        `-${o * 0.5}px -${o * 0.5}px 0 #000`,
        `${o * 0.5}px -${o * 0.5}px 0 #000`,
        `-${o * 0.5}px ${o * 0.5}px 0 #000`
      );
    }
    if (template.shadow === 'soft') {
      parts.push('0 2px 6px rgba(0,0,0,0.75)');
    } else if (template.shadow === 'strong') {
      parts.push('0 4px 14px rgba(0,0,0,0.95), 0 2px 4px rgba(0,0,0,0.9)');
    }
    if (template.loopAnimation === 'glow') {
      parts.push(`0 0 14px ${template.accentColor || '#A855F7'}`);
    }
    return parts.length > 0 ? parts.join(', ') : 'none';
  }, [template.outline, template.shadow, template.loopAnimation, template.accentColor]);

  const isVerticalStage = effectiveRatioKey === '9:16' || effectiveRatioKey === '4:5';
  const scaledFontSize = Math.max(
    14,
    Math.min(34, Math.round((template.fontSize || 28) * (isVerticalStage ? 0.62 : 0.72)))
  );

  // Typewriter or Character-by-character slice
  const displayedText = useMemo(() => {
    if (!activeSegment) return '';
    if (
      template.entranceAnimation === 'typewriter' ||
      template.animateBy === 'character'
    ) {
      const charCount = Math.max(
        1,
        Math.ceil(activeSegment.text.length * Math.min(1, segProgress * 1.35))
      );
      return activeSegment.text.slice(0, charCount);
    }
    return activeSegment.text;
  }, [activeSegment, template.entranceAnimation, template.animateBy, segProgress]);

  const renderRatioIcon = (id: VideoAspectRatio) => {
    if (id === '9:16' || id === '4:5') return <Smartphone className="w-3 h-3" />;
    if (id === '1:1') return <Square className="w-3 h-3" />;
    if (id === 'original') return <Maximize2 className="w-3 h-3" />;
    return <Monitor className="w-3 h-3" />;
  };

  return (
    <div className="flex flex-col border border-slate-800 bg-[#111827] rounded-xl overflow-hidden">
      {/* Top Video Aspect Ratio & Fit/Fill Control Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2 bg-[#0B0B10] border-b border-slate-800/90">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[11px] font-semibold text-zinc-400 mr-1">Aspect Ratio:</span>
          {ASPECT_RATIO_OPTIONS.map((opt) => {
            const isActive = selectedRatio === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => handleSelectAspectRatio(opt.id)}
                title={`${opt.label} (${opt.badge})`}
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold transition-all whitespace-nowrap ${
                  isActive
                    ? 'bg-[#2B1644] text-white border border-[#9353D3] shadow-sm'
                    : 'bg-[#15151E] text-zinc-400 hover:text-zinc-200 border border-[#242432]'
                }`}
              >
                {renderRatioIcon(opt.id)}
                <span>
                  {opt.id === 'original' ? `Auto (${effectiveRatioKey})` : opt.label}
                </span>
              </button>
            );
          })}
        </div>

        {/* Fit vs Fill Crop Switcher */}
        <div className="flex items-center gap-1 bg-[#15151E] p-0.5 rounded-lg border border-[#242432]">
          {(
            [
              { id: 'fit', label: 'Fit' },
              { id: 'fill', label: 'Fill' },
            ] as { id: VideoScaleMode; label: string }[]
          ).map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => handleSelectScaleMode(m.id)}
              className={`px-2 py-0.5 rounded text-[11px] font-semibold transition-colors ${
                selectedScaleMode === m.id
                  ? 'bg-[#7C3AED] text-white'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Dynamic Aspect Ratio Broadcast Stage (9:16, 16:9, 1:1, 4:5, 4:3) */}
      <div className="relative bg-[#07070B] flex items-center justify-center p-2.5 min-h-[280px] select-none overflow-hidden">
        <div
          className={`relative ${frameBoxClasses} bg-black rounded-lg overflow-hidden shadow-[0_0_30px_rgba(0,0,0,0.8)] border border-white/10 flex items-center justify-center transition-all duration-200`}
        >
          {resolvedVideoUrl && !videoError ? (
            <video
              ref={videoRef}
              src={resolvedVideoUrl}
              className={`w-full h-full ${
                selectedScaleMode === 'fill' ? 'object-cover' : 'object-contain'
              } ${videoVisible ? 'opacity-100' : 'opacity-0'}`}
              playsInline
              onTimeUpdate={(e) => onTimeUpdate(e.currentTarget.currentTime)}
              onLoadedMetadata={(e) => {
                const el = e.currentTarget;
                if (el.duration && Number.isFinite(el.duration)) {
                  onDurationLoaded(el.duration);
                }
                if (el.videoWidth && el.videoHeight) {
                  setNaturalDim({ width: el.videoWidth, height: el.videoHeight });
                }
              }}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onEnded={() => setIsPlaying(false)}
              onError={() => setVideoError(true)}
              onClick={togglePlay}
            />
          ) : (
            <div
              onClick={togglePlay}
              className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 cursor-pointer p-6 text-center"
            >
              <div className="text-xs font-mono text-slate-400 tabular-nums mb-1">
                VIDEO PREVIEW · {effectiveRatioKey} · KHMER + ENGLISH
              </div>
              <p className="text-xs text-slate-500 max-w-sm">
                Click play to preview synchronized Khmer & English subtitles and animations.
              </p>
            </div>
          )}

          {/* Optional Broadcast Safe Area Guides */}
          {template.showSafeArea && (
            <div className="pointer-events-none absolute inset-[6%] border border-dashed border-amber-400/45 rounded flex items-start justify-end p-1.5 z-20">
              <span className="text-[10px] font-mono text-amber-300/80">SAFE AREA 90%</span>
            </div>
          )}

          {/* Measured Contrast Scrim */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/80 via-black/35 to-transparent" />

          {/* Live Synchronized Subtitle / Karaoke Overlay */}
          {captionsVisible && activeSegment && (
            <div
              style={positionContainerStyle}
              className={`pointer-events-none absolute z-10 ${
                template.background === 'full_width' ? 'w-full' : 'w-[90%] flex justify-center'
              }`}
            >
              <div
                className={`${backgroundClass} transition-all duration-150`}
                style={{
                  ...animationTransformStyle,
                  fontFamily: resolveFontFamilyCss(template.font, template.customFontName),
                  fontSize: `${scaledFontSize}px`,
                  fontWeight: resolveFontWeightCss(template.fontWeight),
                  color: template.primaryColor,
                  textShadow: textShadowStyle,
                  textAlign: template.alignment || 'center',
                  lineHeight: 1.45,
                  maxWidth: template.background === 'full_width' ? '100%' : '96%',
                }}
              >
                {(template.entranceAnimation === 'word_by_word' ||
                  (template.wordAnimation && template.wordAnimation !== 'none')) &&
                tokens.length > 0 ? (
                  <span className="inline-flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1">
                    {tokens.map((word, idx) => {
                      const isSpoken = idx === activeWordIdx;
                      const isPast = idx < activeWordIdx;
                      const effectiveWordMode =
                        template.entranceAnimation === 'word_by_word'
                          ? 'word_by_word'
                          : template.wordAnimation;
                      if (effectiveWordMode === 'word_by_word' && idx > activeWordIdx) {
                        return null;
                      }
                      return (
                        <span
                          key={idx}
                          className="inline-block transition-transform duration-150 px-1 rounded"
                          style={{
                            color:
                              effectiveWordMode === 'karaoke' && (isSpoken || isPast)
                                ? template.accentColor
                                : isSpoken
                                  ? template.accentColor
                                  : template.primaryColor,
                            backgroundColor:
                              effectiveWordMode === 'highlight' && isSpoken
                                ? `${template.accentColor}33`
                                : 'transparent',
                            transform:
                              effectiveWordMode === 'bounce' && isSpoken
                                ? 'translateY(-3px) scale(1.08)'
                                : isSpoken && effectiveWordMode === 'karaoke'
                                  ? 'scale(1.05)'
                                  : 'none',
                          }}
                        >
                          {word}
                        </span>
                      );
                    })}
                  </span>
                ) : (
                  <span>{displayedText}</span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Dedicated Subtitle Preview Strip under Video */}
      <div className="px-4 py-2 bg-slate-950 border-t border-slate-800/90 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[11px] font-mono text-slate-500 uppercase shrink-0">
            Subtitle Preview:
          </span>
          <span
            className="text-sm text-slate-100 truncate"
            style={{ fontFamily: resolveFontFamilyCss(template.font, template.customFontName) }}
          >
            {activeSegment ? activeSegment.text : 'សួស្តីអ្នកទាំងអស់គ្នា · Ready for playback'}
          </span>
        </div>
        <div className="text-[11px] font-mono text-purple-300 tabular-nums whitespace-nowrap shrink-0">
          {effectiveRatioKey} · {selectedScaleMode.toUpperCase()} · In:{' '}
          {(template.entranceAnimation || 'pop').toUpperCase()}
        </div>
      </div>

      {/* Audio / Video Bottom Control Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-t border-slate-800 bg-[#0F1522]">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={togglePlay}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-400 text-slate-950 hover:bg-amber-300 text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
          >
            {isPlaying ? (
              <>
                <Pause className="w-3.5 h-3.5 fill-current" />
                <span>Pause</span>
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>Play</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={jumpToPreviousSubtitle}
            title="Previous Subtitle"
            className="flex items-center gap-1 px-2 py-1.5 text-xs text-slate-300 hover:text-white hover:bg-slate-800 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            <SkipBack className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Prev</span>
          </button>

          <button
            type="button"
            onClick={jumpToNextSubtitle}
            title="Next Subtitle"
            className="flex items-center gap-1 px-2 py-1.5 text-xs text-slate-300 hover:text-white hover:bg-slate-800 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            <SkipForward className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Next</span>
          </button>

          <button
            type="button"
            onClick={() => skipSeconds(-5)}
            className="flex items-center gap-1 px-2 py-1.5 text-xs font-mono text-slate-300 hover:text-white hover:bg-slate-800 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            <Rewind className="w-3.5 h-3.5" />
            <span>-5s</span>
          </button>

          <button
            type="button"
            onClick={() => skipSeconds(5)}
            className="flex items-center gap-1 px-2 py-1.5 text-xs font-mono text-slate-300 hover:text-white hover:bg-slate-800 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            <FastForward className="w-3.5 h-3.5" />
            <span>+5s</span>
          </button>

          <div className="pl-1 font-mono text-xs text-slate-300 tabular-nums whitespace-nowrap">
            <span className="text-amber-400 font-semibold">{formatTimestampHMS(currentTime)}</span>
            <span className="mx-1 text-slate-600">/</span>
            <span>{formatTimestampHMS(durationSec || 18)}</span>
          </div>
        </div>

        {/* Speed Selector (0.5x | 1x | 1.5x | 2x) + Volume + Add Subtitle */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 p-0.5 bg-slate-950 border border-slate-800 rounded-lg">
            {[0.5, 1, 1.5, 2].map((rate) => (
              <button
                key={rate}
                type="button"
                onClick={() => setSpeed(rate)}
                className={`px-2 py-1 font-mono text-[11px] rounded transition-colors tabular-nums whitespace-nowrap shrink-0 ${
                  playbackRate === rate
                    ? 'bg-slate-800 text-amber-400 font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {rate}×
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={toggleMute}
            className="p-1.5 text-slate-300 hover:text-white hover:bg-slate-800 rounded-md transition-colors"
            title={isMuted ? 'Unmute' : 'Volume'}
          >
            {isMuted ? (
              <VolumeX className="w-4 h-4 text-rose-400" />
            ) : (
              <Volume2 className="w-4 h-4" />
            )}
          </button>

          <button
            type="button"
            onClick={() => onAddSegmentAtCurrentTime(currentTime)}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>+ Add Subtitle</span>
          </button>
        </div>
      </div>
    </div>
  );
};
