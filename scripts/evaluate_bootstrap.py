"""Run patient-level bootstrap confidence intervals for early detection policies.

Quantifies statistical stability and paired differences between Baseline (1h)
and Experiment 5 (2-of-3h confirmation) on the frozen test cohort.
"""
from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path
import sys
import time

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import pandas as pd

from src.bootstrap_evaluation import (
    export_bootstrap_csv,
    format_bootstrap_report,
    precompute_patient_cohort,
    run_patient_bootstrap,
)
from src.common import PROJECT_ROOT, save_json

LOGGER = logging.getLogger(__name__)


def run(
    model: str = "xgboost",
    split: str = "test",
    n_iterations: int = 2000,
    seed: int = 42,
    output_dir: Optional[Path] = None,
) -> Dict[str, Any]:
    started = time.perf_counter()
    output_path = Path(output_dir or PROJECT_ROOT / "reports/early_detection").resolve()
    output_path.mkdir(parents=True, exist_ok=True)

    # 1. Load frozen model threshold
    threshold_path = PROJECT_ROOT / f"models/{model}/threshold.json"
    if not threshold_path.is_file():
        raise FileNotFoundError(f"Missing threshold file: {threshold_path}")
    threshold_data = json.loads(threshold_path.read_text(encoding="utf-8"))
    threshold = float(threshold_data["threshold"])

    # 2. Define policies
    policy_baseline = {
        "label_shift_hours": 6,
        "min_lead_hours": 6,
        "max_lead_hours": 12,
        "secondary_min_lead_hours": [1, 3, 6],
        "consecutive_positive_hours": 1,
        "alert_window_hours": 1,
        "alert_min_positive_in_window": 1,
    }
    policy_exp5 = {
        "label_shift_hours": 6,
        "min_lead_hours": 6,
        "max_lead_hours": 12,
        "secondary_min_lead_hours": [1, 3, 6],
        "consecutive_positive_hours": 1,
        "alert_window_hours": 3,
        "alert_min_positive_in_window": 2,
    }

    # 3. Load prediction data
    pred_path = PROJECT_ROOT / f"reports/models/{model}/{split}_predictions.csv.gz"
    if not pred_path.is_file():
        raise FileNotFoundError(f"Missing predictions file: {pred_path}")

    LOGGER.info("Loading %s %s predictions from %s...", model, split, pred_path.name)
    df = pd.read_csv(
        pred_path,
        dtype={"patient_id": str, "dataset": str},
        float_precision="round_trip",
    )

    ids = df["patient_id"].to_numpy()
    boundaries = np.r_[0, np.flatnonzero(ids[1:] != ids[:-1]) + 1, len(ids)]
    n_patients = len(boundaries) - 1
    LOGGER.info("Found %d distinct patient records (%d rows).", n_patients, len(df))

    LOGGER.info("Precomputing patient-level outcomes for Baseline and Exp 5...")
    patient_frames = [
        df.iloc[start:stop].copy()
        for start, stop in zip(boundaries[:-1], boundaries[1:])
    ]
    precomputed = precompute_patient_cohort(
        patient_frames, threshold, policy_baseline, policy_exp5
    )

    LOGGER.info(
        "Executing patient-level bootstrap resampling (%d iterations, seed=%d)...",
        n_iterations,
        seed,
    )
    bootstrap_results = run_patient_bootstrap(
        precomputed, n_iterations=n_iterations, seed=seed, alpha=0.05
    )

    report_text = format_bootstrap_report(
        bootstrap_results, model_name=model, split_name=split, threshold=threshold
    )

    # Save reports
    txt_path = output_path / "bootstrap_comparison.txt"
    txt_path.write_text(report_text + "\n", encoding="utf-8")
    LOGGER.info("Saved text report to: %s", txt_path)

    csv_path = output_path / "bootstrap_comparison.csv"
    export_bootstrap_csv(bootstrap_results, csv_path)
    LOGGER.info("Saved CSV summary to: %s", csv_path)

    json_path = output_path / "bootstrap_comparison.json"
    save_json(
        json_path,
        {
            "model": model,
            "split": split,
            "threshold": threshold,
            "policy_baseline": policy_baseline,
            "policy_exp5": policy_exp5,
            "elapsed_seconds": round(time.perf_counter() - started, 2),
            "bootstrap_results": bootstrap_results,
        },
    )
    LOGGER.info("Saved JSON metrics to: %s", json_path)

    LOGGER.info("Bootstrap evaluation completed in %.2fs.", time.perf_counter() - started)
    print("\n" + report_text)
    return bootstrap_results


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="xgboost", help="Model name (default: xgboost)")
    parser.add_argument("--split", default="test", help="Cohort split (default: test)")
    parser.add_argument(
        "--iterations",
        type=int,
        default=2000,
        help="Number of bootstrap resamples (default: 2000)",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed for reproducibility (default: 42)",
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Output directory (default: reports/early_detection)",
    )
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = parser.parse_args()
    run(
        model=args.model,
        split=args.split,
        n_iterations=args.iterations,
        seed=args.seed,
        output_dir=args.output_dir,
    )

