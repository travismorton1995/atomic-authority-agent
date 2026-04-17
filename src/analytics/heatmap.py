"""Generate a day × time-window engagement heatmap as PNG."""
import json
import sys
import numpy as np
import seaborn as sns
import matplotlib.pyplot as plt
from datetime import datetime

HISTORY_FILE = 'posted_history.json'

DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
WINDOWS = ['7-9a', '9-11a', '11a-1p', '1-3p', '3-5p', '5-7p', '7-9p']

def get_time_window(hour, minute=0):
    total = hour * 60 + minute
    if 420 <= total < 540: return '7-9a'
    if 540 <= total < 660: return '9-11a'
    if 660 <= total < 780: return '11a-1p'
    if 780 <= total < 900: return '1-3p'
    if 900 <= total < 1020: return '3-5p'
    if 1020 <= total < 1140: return '5-7p'
    if 1140 <= total < 1260: return '7-9p'
    return None

SCORE_WEIGHTS = {
    'newFollowers': 10, 'reposts': 5, 'sends': 5,
    'comments': 3, 'saves': 3, 'reactions': 1, 'impressions': 0.01,
}

def composite_score(m):
    if not m: return 0
    return sum((m.get(k, 0) or 0) * w for k, w in SCORE_WEIGHTS.items())

def main():
    output_path = sys.argv[1] if len(sys.argv) > 1 else 'heatmap.png'

    with open(HISTORY_FILE, 'r') as f:
        history = json.load(f)

    # Build grid
    grid = {(d, w): [] for d in DAYS for w in WINDOWS}

    for post in history:
        if post.get('status') != 'published' or not post.get('metrics') or not post.get('publishedAt'):
            continue
        dt = datetime.fromisoformat(post['publishedAt'].replace('Z', '+00:00'))
        # Convert to ET (UTC-4 or UTC-5 — approximate with UTC-4 for simplicity)
        from zoneinfo import ZoneInfo
        dt_et = dt.astimezone(ZoneInfo('America/Toronto'))
        day = dt_et.strftime('%a')
        window = get_time_window(dt_et.hour, dt_et.minute)
        if day in DAYS and window in WINDOWS:
            score = composite_score(post['metrics'])
            grid[(day, window)].append(score)

    # Build matrix: avg score per cell, NaN for empty
    matrix = np.full((len(WINDOWS), len(DAYS)), np.nan)
    counts = np.full((len(WINDOWS), len(DAYS)), 0)
    for di, d in enumerate(DAYS):
        for wi, w in enumerate(WINDOWS):
            scores = grid[(d, w)]
            if scores:
                matrix[wi, di] = np.mean(scores)
                counts[wi, di] = len(scores)

    # Create annotation labels: score + count
    annot = np.empty((len(WINDOWS), len(DAYS)), dtype=object)
    for wi in range(len(WINDOWS)):
        for di in range(len(DAYS)):
            if np.isnan(matrix[wi, di]):
                annot[wi, di] = ''
            else:
                annot[wi, di] = f'{matrix[wi, di]:.0f}\n({counts[wi, di]:g})'

    # Flip so earlier time windows are at the bottom
    matrix = matrix[::-1]
    annot = annot[::-1]
    flipped_windows = WINDOWS[::-1]

    fig, ax = plt.subplots(figsize=(8, 5))
    sns.heatmap(
        matrix, ax=ax,
        xticklabels=DAYS, yticklabels=flipped_windows,
        cmap='RdYlGn', center=np.nanmedian(matrix),
        annot=annot, fmt='',
        linewidths=1, linecolor='white',
        cbar_kws={'label': 'Avg Composite Score'},
        mask=np.isnan(matrix),
    )
    ax.set_title('Engagement by Day & Time Window', fontsize=14, fontweight='bold', pad=12)
    ax.set_xlabel('')
    ax.set_ylabel('')

    # Gray out empty cells
    for wi in range(len(flipped_windows)):
        for di in range(len(DAYS)):
            if np.isnan(matrix[wi, di]):
                ax.add_patch(plt.Rectangle((di, wi), 1, 1, fill=True, color='#f0f0f0', zorder=0))

    plt.tight_layout()
    plt.savefig(output_path, dpi=150, bbox_inches='tight')
    plt.close()
    print(f'Heatmap saved to {output_path}')

if __name__ == '__main__':
    main()
