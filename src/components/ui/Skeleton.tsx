type SkeletonProps = {
  readonly width?: string
  readonly height?: string
  readonly lines?: number
  readonly circle?: boolean
}

export function Skeleton({ width, height, lines = 1, circle }: SkeletonProps) {
  if (circle) {
    return (
      <div
        className="v-skeleton v-skeleton-circle"
        style={{ width: width ?? '40px', height: height ?? '40px' }}
      />
    )
  }

  if (lines > 1) {
    return (
      <div className="v-skeleton-group">
        {Array.from({ length: lines }, (_, i) => (
          <div
            key={i}
            className="v-skeleton v-skeleton-bar"
            style={{
              width: i === lines - 1 ? '60%' : width ?? '100%',
              height: height ?? '14px',
            }}
          />
        ))}
      </div>
    )
  }

  return (
    <div
      className="v-skeleton v-skeleton-bar"
      style={{ width: width ?? '100%', height: height ?? '14px' }}
    />
  )
}

export function SkeletonRow({ columns = 4 }: { readonly columns?: number }) {
  return (
    <div className="v-skeleton-row">
      {Array.from({ length: columns }, (_, i) => (
        <div
          key={i}
          className="v-skeleton v-skeleton-bar"
          style={{ width: i === 0 ? '30%' : i === columns - 1 ? '15%' : '20%', height: '14px' }}
        />
      ))}
    </div>
  )
}

export function SkeletonCard() {
  return (
    <div className="v-skeleton-card">
      <Skeleton height="16px" width="40%" />
      <Skeleton lines={3} />
      <Skeleton height="32px" width="30%" />
    </div>
  )
}
