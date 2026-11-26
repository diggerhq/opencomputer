import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Star } from 'lucide-react'
import { ApiError } from '@/api/errors'
import {
  claimGitHubStar,
  getGitHubStar,
  startGitHubStar,
  type GitHubStar,
} from '@/api/client'
import { Button } from '@/components/ui/button'
import { notifyError, notifySuccess } from '@/lib/errors'

const queryKey = ['github-star']

/**
 * "Star us on GitHub, get $5" beside setup. The check is loose on purpose:
 * the edge only sees the repo's star count go up after the click.
 */
export function GitHubStarBonus() {
  const queryClient = useQueryClient()
  const star = useQuery({ queryKey, queryFn: getGitHubStar, retry: false })
  const save = (next: GitHubStar) => queryClient.setQueryData(queryKey, next)

  const start = useMutation({ mutationFn: startGitHubStar, onSuccess: save })
  const claim = useMutation({
    mutationFn: claimGitHubStar,
    onSuccess: (next) => {
      save(next)
      if (!next.claimed) return
      notifySuccess(
        `$${next.bonusUsd} added to your credits. Thanks for the star!`,
      )
      void queryClient.invalidateQueries({ queryKey: ['autumn-billing'] })
    },
    onError: (error) =>
      notifyError(
        error instanceof ApiError && error.status === 409
          ? "We don't see your star yet. Give GitHub a few seconds and try again."
          : "Couldn't add the credits.",
        error,
      ),
  })

  const data = star.data
  if (!data?.eligible) return null
  return (
    <div className="bg-panel rounded-xl border p-5 text-sm shadow-sm">
      <h2 className="flex items-center gap-2 font-semibold">
        <Star className="size-4 fill-amber-400 text-amber-400" aria-hidden />
        Get ${data.bonusUsd} in credits
      </h2>
      <p className="text-muted-foreground mt-2">
        Star OpenComputer on GitHub and we add ${data.bonusUsd} to your trial.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant={data.started ? 'outline' : 'default'}
          size="sm"
          asChild
        >
          <a
            href={data.repoUrl}
            target="_blank"
            rel="noreferrer"
            onClick={() => start.mutate()}
          >
            Star on GitHub
          </a>
        </Button>
        {data.started ? (
          <Button
            size="sm"
            disabled={claim.isPending}
            onClick={() => claim.mutate()}
          >
            {claim.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : null}
            I starred it
          </Button>
        ) : null}
      </div>
    </div>
  )
}
