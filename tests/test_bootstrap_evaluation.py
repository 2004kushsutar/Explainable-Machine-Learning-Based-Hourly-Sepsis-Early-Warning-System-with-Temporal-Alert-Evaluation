"""Unit tests for patient-level bootstrap resampling and paired confidence intervals."""
import unittest
import numpy as np
import pandas as pd

from src.bootstrap_evaluation import (
    compute_patient_utility,
    compute_patient_optimal_utility,
    compute_patient_zero_utility,
    generate_alerts,
    precompute_patient_cohort,
    evaluate_sample_metrics,
    run_patient_bootstrap,
)


def make_patient(
    patient_id: str,
    n_hours: int = 15,
    first_positive: int = None,
    warn_hours: tuple = (),
) -> pd.DataFrame:
    hours = np.arange(1, n_hours + 1)
    labels = np.zeros(n_hours, dtype=int)
    if first_positive is not None:
        labels = (hours >= first_positive).astype(int)
    warned = np.isin(hours, warn_hours)
    return pd.DataFrame({
        "patient_id": patient_id,
        "dataset": "A",
        "ICULOS": hours.astype(float),
        "SepsisLabel": labels,
        "probability": np.where(warned, 0.9, 0.1),
        "predicted_SepsisLabel": warned.astype(int),
    })


class BootstrapEvaluationTests(unittest.TestCase):
    def setUp(self):
        self.policy_base = {
            "label_shift_hours": 6,
            "min_lead_hours": 6,
            "max_lead_hours": 12,
            "secondary_min_lead_hours": [1, 3, 6],
            "consecutive_positive_hours": 1,
            "alert_window_hours": 1,
            "alert_min_positive_in_window": 1,
        }
        self.policy_exp5 = {
            "label_shift_hours": 6,
            "min_lead_hours": 6,
            "max_lead_hours": 12,
            "secondary_min_lead_hours": [1, 3, 6],
            "consecutive_positive_hours": 1,
            "alert_window_hours": 3,
            "alert_min_positive_in_window": 2,
        }

    def test_physionet_utility_analytical_cases(self):
        # Non-septic patient with zero predictions -> utility = 0.0
        labels = np.zeros(20, dtype=int)
        preds = np.zeros(20, dtype=int)
        self.assertAlmostEqual(compute_patient_utility(labels, preds), 0.0)

        # Non-septic patient with 3 false positive alerts -> 3 * (-0.05) = -0.15
        preds[2] = 1
        preds[5] = 1
        preds[8] = 1
        self.assertAlmostEqual(compute_patient_utility(labels, preds), -0.15)

        # Optimal predictor on septic patient
        labels_sep = np.zeros(20, dtype=int)
        labels_sep[10:] = 1  # onset = 10 + 6 = 16
        u_opt = compute_patient_optimal_utility(labels_sep)
        self.assertGreater(u_opt, 0.0)

        # Zero predictor on septic patient (penalty for missing onset window)
        u_zero = compute_patient_zero_utility(labels_sep)
        self.assertLess(u_zero, 0.0)

    def test_generate_alerts_confirmation(self):
        # Raw predictions: positive at hours 2 and 4 (indices 1 and 3)
        preds = np.array([0, 1, 0, 1, 0, 0], dtype=bool)

        # 1h mode -> alerts match preds
        alerts_1h = generate_alerts(preds, window_size=1, min_pos=1)
        np.testing.assert_array_equal(alerts_1h, preds)

        # 2-of-3 mode:
        # idx 0: [0] -> sum 0 -> False
        # idx 1: [0, 1] -> sum 1 -> False
        # idx 2: [0, 1, 0] -> sum 1 -> False
        # idx 3: [1, 0, 1] -> sum 2 -> True (confirmed at idx 3)
        # idx 4: [0, 1, 0] -> sum 1 -> False
        # idx 5: [1, 0, 0] -> sum 1 -> False
        alerts_2of3 = generate_alerts(preds, window_size=3, min_pos=2)
        expected = np.array([False, False, False, True, False, False])
        np.testing.assert_array_equal(alerts_2of3, expected)

    def test_duplicate_sampled_patients_scaling(self):
        # 1 nonseptic patient with 1 alert episode and 10 hours
        p1 = make_patient("p1", n_hours=10, first_positive=None, warn_hours=(3,))
        # 1 septic patient detected by both
        p2 = make_patient("p2", n_hours=20, first_positive=14, warn_hours=(8, 9))

        pre = precompute_patient_cohort([p1, p2], 0.5, self.policy_base, self.policy_exp5)

        # Sample [0, 0] -> patient 0 sampled twice
        metrics_double_p1 = evaluate_sample_metrics(np.array([0, 0]), pre)
        self.assertEqual(metrics_double_p1["nonseptic_false_alarm_rate"]["baseline"], 1.0)
        self.assertAlmostEqual(
            metrics_double_p1["nonseptic_alert_episodes_per_100_hours"]["baseline"],
            100.0 * 2 / 20.0,
        )

        # Sample [1, 1, 1] -> septic patient sampled 3 times
        metrics_triple_p2 = evaluate_sample_metrics(np.array([1, 1, 1]), pre)
        self.assertEqual(metrics_triple_p2["primary_sensitivity_6_12h"]["baseline"], 1.0)
        self.assertEqual(metrics_triple_p2["primary_sensitivity_6_12h"]["exp5"], 1.0)

    def test_paired_bootstrap_preserves_differences_and_bounds(self):
        patients = [
            make_patient("p1", n_hours=10, first_positive=None, warn_hours=(3,)),       # base alerts, exp5 quiet
            make_patient("p2", n_hours=10, first_positive=None, warn_hours=()),         # quiet
            make_patient("p3", n_hours=24, first_positive=14, warn_hours=(8,)),         # base detects, exp5 misses (1 hit)
            make_patient("p4", n_hours=24, first_positive=14, warn_hours=(8, 9)),       # both detect (2 consecutive)
            make_patient("p5", n_hours=12, first_positive=None, warn_hours=(2, 3, 4)),  # both alert
        ]
        pre = precompute_patient_cohort(patients, 0.5, self.policy_base, self.policy_exp5)

        boot = run_patient_bootstrap(pre, n_iterations=200, seed=123, alpha=0.05)
        self.assertEqual(boot["n_patients"], 5)
        self.assertEqual(boot["n_iterations"], 200)

        for m_name, m_data in boot["metrics"].items():
            base = m_data["baseline"]
            exp5 = m_data["exp5"]
            diff = m_data["difference"]

            if np.isfinite(base["point_estimate"]) and np.isfinite(exp5["point_estimate"]):
                self.assertAlmostEqual(
                    diff["point_estimate"],
                    exp5["point_estimate"] - base["point_estimate"],
                    places=6,
                )

            # Check CI ordering
            if np.isfinite(diff["ci_lower"]) and np.isfinite(diff["ci_upper"]):
                self.assertLessEqual(diff["ci_lower"], diff["ci_upper"])

    def test_seed_determinism(self):
        patients = [
            make_patient("p1", n_hours=10, first_positive=None, warn_hours=(3,)),
            make_patient("p2", n_hours=20, first_positive=14, warn_hours=(8, 9)),
        ]
        pre = precompute_patient_cohort(patients, 0.5, self.policy_base, self.policy_exp5)
        res1 = run_patient_bootstrap(pre, n_iterations=100, seed=999)
        res2 = run_patient_bootstrap(pre, n_iterations=100, seed=999)

        diff1 = res1["metrics"]["nonseptic_false_alarm_rate"]["difference"]["mean"]
        diff2 = res2["metrics"]["nonseptic_false_alarm_rate"]["difference"]["mean"]
        self.assertEqual(diff1, diff2)

    def test_empty_cohort_raises(self):
        with self.assertRaises(ValueError):
            precompute_patient_cohort([], 0.5, self.policy_base, self.policy_exp5)


if __name__ == "__main__":
    unittest.main()

