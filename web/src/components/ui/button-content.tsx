'use client'

import { Progress as ProgressPrimitive } from '@base-ui/react/progress'
import { cn } from '@/lib/utils'
import { useState } from 'react'

// Each dot rises in a beat after the label starts leaving, then bounces in turn.
const LOADING_DOTS = [
  { bounce: '[animation-delay:0ms]', enter: '[animation-delay:70ms]' },
  { bounce: '[animation-delay:140ms]', enter: '[animation-delay:110ms]' },
  { bounce: '[animation-delay:280ms]', enter: '[animation-delay:150ms]' },
] as const

/* True from the first `loading` change until the swap back has finished, so
   buttons don't animate on mount and stop clipping once they're idle again. */
function useLoadingSwap(loading: boolean) {
  const [previousLoading, setPreviousLoading] = useState(loading)
  const [isSwapping, setIsSwapping] = useState(false)
  if (loading !== previousLoading) {
    setPreviousLoading(loading)
    setIsSwapping(true)
  }
  return { finishSwap: () => setIsSwapping(false), isSwapping }
}

/* Clearing `progress` keeps the bar mounted at 100% until it has faded out. */
function useProgressCompletion(hasProgress: boolean) {
  const [previousHasProgress, setPreviousHasProgress] = useState(hasProgress)
  const [isCompleting, setIsCompleting] = useState(false)
  if (hasProgress !== previousHasProgress) {
    setPreviousHasProgress(hasProgress)
    setIsCompleting(!hasProgress)
  }
  return { finishCompletion: () => setIsCompleting(false), isCompleting }
}

function ButtonProgress({
  completing,
  onFaded,
  value,
}: {
  completing: boolean
  onFaded: () => void
  value: number
}) {
  return (
    // Decorative: a button's content only feeds its accessible name, so the
    // progressbar role (and Base UI's hidden "x") would just garble it.
    // `Button` describes the percentage through `aria-describedby` instead.
    <ProgressPrimitive.Root
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-0',
        completing && 'animate-button-progress-out',
      )}
      data-slot="button-progress"
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) {
          onFaded()
        }
      }}
      render={<span />}
      value={value}
    >
      <ProgressPrimitive.Track
        className="absolute inset-0 overflow-hidden"
        render={<span />}
      >
        <ProgressPrimitive.Indicator
          className="absolute inset-y-0 start-0 bg-current/15 transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
          render={<span />}
        />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  )
}

function ButtonLoader({
  entering,
  loading,
  onSwappedOut,
}: {
  entering: boolean
  loading: boolean
  onSwappedOut: () => void
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-0 flex items-center justify-center gap-[0.2em]',
        !loading &&
          'animate-button-swap-out opacity-0 motion-reduce:animate-none',
      )}
      data-slot="button-loader"
      onAnimationEnd={(event) => {
        if (!loading && event.target === event.currentTarget) {
          onSwappedOut()
        }
      }}
    >
      {LOADING_DOTS.map(({ bounce, enter }) => (
        <span
          className={cn(
            'motion-reduce:animate-none',
            loading && entering && `animate-button-swap-in ${enter}`,
          )}
          key={enter}
        >
          <span
            className={cn(
              'animate-button-dot block size-[0.3em] rounded-full bg-current motion-reduce:animate-none',
              bounce,
              !loading && '[animation-play-state:paused]',
            )}
          />
        </span>
      ))}
    </span>
  )
}

interface ButtonContentProps {
  children?: React.ReactNode
  loading: boolean
  progress: number | undefined
  progressTextId: string
}

/* The animated inside of `Button`: the label, the loading dots and the
   progress fill. Kept in its own client module so `button.tsx` stays importable
   from server components that only call `buttonVariants`. The label is only
   wrapped while a state is showing, so idle buttons keep their children as
   direct children and `[&>svg]`-style selectors keep working. */
function ButtonContent({
  children,
  loading,
  progress,
  progressTextId,
}: ButtonContentProps) {
  const hasProgress = progress !== undefined
  const { finishSwap, isSwapping } = useLoadingSwap(loading)
  const { finishCompletion, isCompleting } = useProgressCompletion(hasProgress)
  const showLoader = loading || isSwapping
  const showProgress = hasProgress || isCompleting

  return (
    <>
      {showProgress && (
        <ButtonProgress
          completing={isCompleting}
          onFaded={finishCompletion}
          value={progress ?? 100}
        />
      )}
      {hasProgress && (
        <span hidden id={progressTextId}>
          {`${Math.round(progress)}%`}
        </span>
      )}
      {showLoader || showProgress ? (
        <span
          className={cn(
            'relative inline-flex min-w-0 flex-1 items-center [justify-content:inherit] [gap:inherit] motion-reduce:animate-none',
            loading && 'opacity-0',
            isSwapping &&
              (loading
                ? 'animate-button-swap-out'
                : 'animate-button-swap-in [animation-delay:70ms]'),
          )}
          // Tells the button to clip the swapping layers to its shape.
          data-clip=""
          data-slot="button-label"
        >
          {children}
        </span>
      ) : (
        children
      )}
      {showLoader && (
        <ButtonLoader
          entering={isSwapping}
          loading={loading}
          onSwappedOut={finishSwap}
        />
      )}
    </>
  )
}

export { ButtonContent }
