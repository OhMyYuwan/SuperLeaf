import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'

export type AuthSlideAccent = 'pink' | 'blue' | 'peach' | 'mint'

export interface AuthSlidePoint {
  id: string
  title: string
  description: string
  visualLabel: string
  visualTitle: string
  visualHint: string
  videoSrc?: string
  videoType?: string
  imageSrc?: string
  imageAlt?: string
}

export interface AuthSlide {
  id: string
  eyebrow: string
  title: string
  description: string
  accent: AuthSlideAccent
  points: AuthSlidePoint[]
}

interface AuthSplitShellProps {
  slides: AuthSlide[]
  activeSlideId: string
  onSlideChange: (id: string) => void
  asideLabel: string
  children: ReactNode
}

const springTransition = {
  type: 'spring' as const,
  stiffness: 210,
  damping: 24,
  mass: 0.9,
}

const AUTO_ADVANCE_MS = 5200

export function AuthSplitShell({
  slides,
  activeSlideId,
  onSlideChange,
  asideLabel,
  children,
}: AuthSplitShellProps) {
  const prefersReducedMotion = useReducedMotion()
  const [activePointIndex, setActivePointIndex] = useState(0)

  const activeIndex = Math.max(
    0,
    slides.findIndex((slide) => slide.id === activeSlideId),
  )
  const activeSlide = slides[activeIndex] ?? slides[0]
  const activePoint = activeSlide.points[activePointIndex] ?? activeSlide.points[0]
  const paletteClass = useMemo(() => `auth-showcase-panel accent-${activeSlide.accent}`, [activeSlide.accent])
  const nextSlide = slides[(activeIndex + 1) % slides.length]

  useEffect(() => {
    if (prefersReducedMotion || !activeSlide.points.length) return

    const timeout = window.setTimeout(() => {
      if (activePointIndex < activeSlide.points.length - 1) {
        setActivePointIndex((index) => index + 1)
        return
      }

      setActivePointIndex(0)
      onSlideChange(nextSlide.id)
    }, AUTO_ADVANCE_MS)

    return () => window.clearTimeout(timeout)
  }, [
    activePointIndex,
    activeSlide.points.length,
    nextSlide.id,
    onSlideChange,
    prefersReducedMotion,
  ])

  const slideMotion = prefersReducedMotion
    ? {
        initial: { opacity: 1, y: 0, scale: 1 },
        animate: { opacity: 1, y: 0, scale: 1 },
        exit: { opacity: 1, y: 0, scale: 1 },
        transition: { duration: 0 },
      }
    : {
        initial: { opacity: 0, y: 32, scale: 0.965 },
        animate: { opacity: 1, y: 0, scale: 1 },
        exit: { opacity: 0, y: -24, scale: 0.985 },
        transition: springTransition,
      }

  const cardMotion = prefersReducedMotion
    ? { whileHover: undefined, whileTap: undefined }
    : { whileHover: { y: -4, scale: 1.01 }, whileTap: { scale: 0.985 } }

  const handleSlideChange = (slideId: string) => {
    setActivePointIndex(0)
    onSlideChange(slideId)
  }

  return (
    <div className="auth-page">
      <div className="auth-page-split">
        <section className="auth-showcase" aria-label={asideLabel}>
          <div className={paletteClass}>
            <div className="auth-showcase-stage">
              <div className="auth-showcase-glow auth-showcase-glow-primary" />
              <div className="auth-showcase-glow auth-showcase-glow-secondary" />
              <AnimatePresence mode="wait">
                <motion.div
                  key={activeSlide.id}
                  className="auth-showcase-heading"
                  initial={slideMotion.initial}
                  animate={slideMotion.animate}
                  exit={slideMotion.exit}
                  transition={slideMotion.transition}
                >
                  <motion.div className="auth-showcase-eyebrow" layout transition={springTransition}>
                    {activeSlide.eyebrow}
                  </motion.div>
                  <motion.h1 className="auth-showcase-title" layout transition={springTransition}>
                    {activeSlide.title}
                  </motion.h1>
                </motion.div>
              </AnimatePresence>

              <AnimatePresence mode="wait">
                <motion.p
                  key={activeSlide.id}
                  className="auth-showcase-description"
                  initial={prefersReducedMotion ? false : { opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={prefersReducedMotion ? undefined : { opacity: 0, y: -8 }}
                  transition={prefersReducedMotion ? { duration: 0 } : springTransition}
                >
                  {activeSlide.description}
                </motion.p>
              </AnimatePresence>

              <motion.div
                className="auth-showcase-copy"
                layout
                transition={springTransition}
              >
                <motion.div
                  className="auth-showcase-points"
                  layout
                  role="tablist"
                  aria-label={`${activeSlide.title} 要点`}
                  transition={springTransition}
                >
                  {activeSlide.points.map((point, index) => {
                    const active = point.id === activePoint?.id
                    return (
                      <motion.button
                        key={point.id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        className={`auth-showcase-point ${active ? 'is-active' : ''}`}
                        onClick={() => setActivePointIndex(index)}
                        initial={prefersReducedMotion ? false : { opacity: 0, x: -18 }}
                        animate={prefersReducedMotion ? { opacity: 1, x: 0 } : { opacity: 1, x: 0 }}
                        transition={
                          prefersReducedMotion
                            ? { duration: 0 }
                            : { ...springTransition, delay: 0.05 * (index + 1) }
                        }
                      >
                        <span className="auth-showcase-point-marker">
                          {String(index + 1).padStart(2, '0')}
                        </span>
                        <span className="auth-showcase-point-copy">
                          <strong>{point.title}</strong>
                          <span>{point.description}</span>
                        </span>
                      </motion.button>
                    )
                  })}
                </motion.div>
              </motion.div>

              <motion.div
                className="auth-showcase-image-slot"
                initial={prefersReducedMotion ? false : { opacity: 0, y: 18, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={prefersReducedMotion ? { duration: 0 } : { ...springTransition, delay: 0.08 }}
              >
                <div className="auth-showcase-image-slot-badge">
                  {activePoint?.visualLabel ?? 'Image'}
                </div>
                <div className="auth-showcase-image-slot-frame">
                  <AnimatePresence mode="wait">
                    {activePoint?.videoSrc ? (
                      <motion.video
                        key={activePoint.id}
                        className="auth-showcase-image-slot-media"
                        aria-label={activePoint.imageAlt || activePoint.visualTitle}
                        autoPlay
                        loop
                        muted
                        playsInline
                        preload="metadata"
                        initial={prefersReducedMotion ? false : { opacity: 0, scale: 1.03 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={prefersReducedMotion ? undefined : { opacity: 0, scale: 0.98 }}
                        transition={prefersReducedMotion ? { duration: 0 } : springTransition}
                      >
                        <source src={activePoint.videoSrc} type={activePoint.videoType || 'video/mp4'} />
                      </motion.video>
                    ) : activePoint?.imageSrc ? (
                      <motion.img
                        key={activePoint.id}
                        className="auth-showcase-image-slot-media"
                        src={activePoint.imageSrc}
                        alt={activePoint.imageAlt || activePoint.visualTitle}
                        initial={prefersReducedMotion ? false : { opacity: 0, scale: 1.03 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={prefersReducedMotion ? undefined : { opacity: 0, scale: 0.98 }}
                        transition={prefersReducedMotion ? { duration: 0 } : springTransition}
                      />
                    ) : (
                      <motion.div
                        key={activePoint?.id ?? activeSlide.id}
                        className="auth-showcase-image-slot-empty"
                        initial={prefersReducedMotion ? false : { opacity: 0, y: 12, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={prefersReducedMotion ? undefined : { opacity: 0, y: -10, scale: 0.99 }}
                        transition={prefersReducedMotion ? { duration: 0 } : springTransition}
                      >
                        <div className="auth-showcase-image-slot-grid" />
                        <div className="auth-showcase-image-slot-placeholder">
                          <span>{activePoint?.visualTitle ?? '预留图片区'}</span>
                          <strong>{activePoint?.visualHint ?? '当前要点可单独配置图片'}</strong>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                  <div className="auth-showcase-image-dots" aria-label="当前 slide 图片轮播位置">
                    {activeSlide.points.map((point, index) => (
                      <button
                        key={point.id}
                        type="button"
                        className={`auth-showcase-image-dot ${point.id === activePoint?.id ? 'is-active' : ''}`}
                        aria-label={`查看图片 ${index + 1}：${point.visualTitle}`}
                        onClick={() => setActivePointIndex(index)}
                      />
                    ))}
                  </div>
                </div>
              </motion.div>
            </div>

            <div className="auth-showcase-footer">
              <div
                id={`auth-slide-panel-${activeSlide.id}`}
                role="tabpanel"
                aria-label={activeSlide.title}
                className="auth-showcase-nav"
              >
                {slides.map((slide, index) => {
                  const active = slide.id === activeSlide.id
                  return (
                    <motion.button
                      key={slide.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      aria-controls={`auth-slide-panel-${slide.id}`}
                      className={`auth-showcase-nav-item accent-${slide.accent} ${active ? 'is-active' : ''}`}
                      onClick={() => handleSlideChange(slide.id)}
                      {...cardMotion}
                      transition={springTransition}
                    >
                      <span className="auth-showcase-nav-index">{String(index + 1).padStart(2, '0')}</span>
                      <span className="auth-showcase-nav-text">
                        <strong>{slide.title}</strong>
                      </span>
                    </motion.button>
                  )
                })}
              </div>
            </div>
          </div>
        </section>

        <motion.aside
          className="auth-aside"
          initial={prefersReducedMotion ? false : { opacity: 0, x: 26, scale: 0.98 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          transition={prefersReducedMotion ? { duration: 0 } : springTransition}
        >
          {children}
        </motion.aside>
      </div>
    </div>
  )
}
