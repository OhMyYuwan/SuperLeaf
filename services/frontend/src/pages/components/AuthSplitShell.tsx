import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'

export type AuthSlideAccent = 'pink' | 'blue' | 'peach' | 'mint'

export interface AuthSlide {
  id: string
  eyebrow: string
  title: string
  description: string
  bullets: string[]
  accent: AuthSlideAccent
  imageSrc?: string
  imageAlt?: string
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

export function AuthSplitShell({
  slides,
  activeSlideId,
  onSlideChange,
  asideLabel,
  children,
}: AuthSplitShellProps) {
  const prefersReducedMotion = useReducedMotion()
  const activeIndex = Math.max(
    0,
    slides.findIndex((slide) => slide.id === activeSlideId),
  )
  const activeSlide = slides[activeIndex] ?? slides[0]
  const paletteClass = useMemo(() => `auth-showcase-panel accent-${activeSlide.accent}`, [activeSlide.accent])
  const previousSlide = slides[(activeIndex - 1 + slides.length) % slides.length]
  const nextSlide = slides[(activeIndex + 1) % slides.length]

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
                className="auth-showcase-copy"
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
                <motion.p className="auth-showcase-description" layout transition={springTransition}>
                  {activeSlide.description}
                </motion.p>
                <motion.ul className="auth-showcase-bullets" layout transition={springTransition}>
                  {activeSlide.bullets.map((bullet, index) => (
                    <motion.li
                      key={`${activeSlide.id}-${bullet}`}
                      initial={prefersReducedMotion ? false : { opacity: 0, x: -18 }}
                      animate={prefersReducedMotion ? { opacity: 1, x: 0 } : { opacity: 1, x: 0 }}
                      transition={
                        prefersReducedMotion
                          ? { duration: 0 }
                          : { ...springTransition, delay: 0.05 * (index + 1) }
                      }
                    >
                      {bullet}
                    </motion.li>
                  ))}
                </motion.ul>
              </motion.div>
            </AnimatePresence>

            <motion.div
              className="auth-showcase-image-slot"
              initial={prefersReducedMotion ? false : { opacity: 0, y: 18, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={prefersReducedMotion ? { duration: 0 } : { ...springTransition, delay: 0.08 }}
            >
              <div className="auth-showcase-image-slot-badge">Image</div>
              <div className="auth-showcase-image-slot-frame">
                {activeSlide.imageSrc ? (
                  <img
                    className="auth-showcase-image-slot-media"
                    src={activeSlide.imageSrc}
                    alt={activeSlide.imageAlt || activeSlide.title}
                  />
                ) : (
                  <>
                    <div className="auth-showcase-image-slot-grid" />
                    <div className="auth-showcase-image-slot-placeholder">
                      <span>预留图片区</span>
                      <strong>当前页可单独配置图片</strong>
                    </div>
                  </>
                )}
              </div>
            </motion.div>
          </div>

          <div className="auth-showcase-footer">
            <div className="auth-showcase-meta">
              <span className="auth-showcase-meta-label">Deck</span>
              <div className="auth-showcase-meta-actions">
                <motion.button
                  type="button"
                  className="auth-showcase-arrow"
                  aria-label={`上一页：${previousSlide.title}`}
                  onClick={() => onSlideChange(previousSlide.id)}
                  whileHover={prefersReducedMotion ? undefined : { scale: 1.05, x: -1 }}
                  whileTap={prefersReducedMotion ? undefined : { scale: 0.95 }}
                  transition={springTransition}
                >
                  &lt;
                </motion.button>
                <span className="auth-showcase-meta-count">
                  {String(activeIndex + 1).padStart(2, '0')} / {String(slides.length).padStart(2, '0')}
                </span>
                <motion.button
                  type="button"
                  className="auth-showcase-arrow"
                  aria-label={`下一页：${nextSlide.title}`}
                  onClick={() => onSlideChange(nextSlide.id)}
                  whileHover={prefersReducedMotion ? undefined : { scale: 1.05, x: 1 }}
                  whileTap={prefersReducedMotion ? undefined : { scale: 0.95 }}
                  transition={springTransition}
                >
                  &gt;
                </motion.button>
              </div>
            </div>

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
                    onClick={() => onSlideChange(slide.id)}
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
