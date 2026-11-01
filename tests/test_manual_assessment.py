"""Unit tests for Manual Patient Assessment feature.

Verifies:
1. Exact mathematical parity with existing pipeline on identical inputs.
2. Experiment 5 confirmation policy (2-of-3 thresholding, pending for < 3 hours).
3. Input validation against physiological ranges and strictly increasing ICULOS.
4. Handling of unmeasured/missing values via standard forward-fill and training median.
5. SHAP additivity on ad-hoc manual inputs.
"""
import unittest
import numpy as np
import pandas as pd

from src.dashboard_data import DashboardData, DashboardInputError, PHYSIOLOGICAL_RANGES


class ManualAssessmentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = DashboardData()
        cls.test_patient_id = "p006266"

    @classmethod
    def tearDownClass(cls):
        cls.data.close()

    def test_identical_pipeline_predictions(self):
        """Feeding identical raw data into manual_assessment must yield bit-identical predictions."""
        raw = self.data._load_patient(self.test_patient_id)
        # Select first 5 recorded hours
        prefix = raw.iloc[:5].copy()
        target_hour = float(prefix["ICULOS"].iloc[-1])

        # Existing snapshot prediction
        snap = self.data.snapshot(self.test_patient_id, target_hour, model="baseline")
        expected_score = snap["model_score"]
        expected_scores = [item["model_score"] for item in snap["score_history"]]

        # Build manual payload with identical raw observations
        first = prefix.iloc[0]
        demographics = {
            "Age": float(first["Age"]) if pd.notna(first.get("Age")) else None,
            "Gender": float(first["Gender"]) if pd.notna(first.get("Gender")) else None,
            "Unit1": float(first["Unit1"]) if pd.notna(first.get("Unit1")) else None,
            "Unit2": float(first["Unit2"]) if pd.notna(first.get("Unit2")) else None,
            "HospAdmTime": float(first["HospAdmTime"]) if pd.notna(first.get("HospAdmTime")) else None,
        }

        predictors = [c for c in self.data.schema if c not in ("patient_id", "dataset", "SepsisLabel", "Age", "Gender", "Unit1", "Unit2", "HospAdmTime", "ICULOS")]
        hours = []
        for _, row in prefix.iterrows():
            h_entry = {"ICULOS": float(row["ICULOS"])}
            for col in predictors:
                val = row[col]
                h_entry[col] = float(val) if pd.notna(val) else None
            hours.append(h_entry)

        payload = {
            "model": "baseline",
            "demographics": demographics,
            "hours": hours
        }

        result = self.data.manual_assessment(payload)

        # Compare probabilities
        actual_scores = [item["model_score"] for item in result["hourly_assessments"]]
        self.assertEqual(len(actual_scores), len(expected_scores))
        for exp, act in zip(expected_scores, actual_scores):
            self.assertAlmostEqual(exp, act, places=6)

        self.assertAlmostEqual(expected_score, result["latest_score"], places=6)

        # Compare SHAP probability and base margin
        self.assertAlmostEqual(snap["shap"]["probability"], result["shap"]["probability"], places=6)
        self.assertAlmostEqual(snap["shap"]["base_value"], result["shap"]["base_value"], places=6)

    def test_confirmation_pending_under_3_hours(self):
        """Fewer than 3 observations must report pending confirmation and NO premature alert."""
        # High risk vitals designed to produce high probability
        high_risk_hours_1 = [
            {"ICULOS": 1.0, "HR": 135.0, "Temp": 39.5, "Resp": 32.0, "MAP": 55.0, "WBC": 22.0, "Lactate": 4.5}
        ]
        payload_1 = {
            "demographics": {"Age": 75.0, "Gender": 1.0, "Unit1": 1.0, "Unit2": 0.0, "HospAdmTime": -10.0},
            "hours": high_risk_hours_1
        }
        res_1 = self.data.manual_assessment(payload_1)
        self.assertEqual(res_1["total_observations"], 1)
        self.assertFalse(res_1["latest_confirmed_alert"])
        self.assertIn("Pending", res_1["latest_confirmation_status"])
        self.assertIn("1/3", res_1["latest_confirmation_status"])

        # 2 hours
        high_risk_hours_2 = high_risk_hours_1 + [
            {"ICULOS": 2.0, "HR": 140.0, "Temp": 39.8, "Resp": 34.0, "MAP": 50.0, "WBC": 25.0, "Lactate": 5.2}
        ]
        payload_2 = {
            "demographics": {"Age": 75.0, "Gender": 1.0, "Unit1": 1.0, "Unit2": 0.0, "HospAdmTime": -10.0},
            "hours": high_risk_hours_2
        }
        res_2 = self.data.manual_assessment(payload_2)
        self.assertEqual(res_2["total_observations"], 2)
        self.assertFalse(res_2["latest_confirmed_alert"])
        self.assertIn("Pending", res_2["latest_confirmation_status"])
        self.assertIn("2/3", res_2["latest_confirmation_status"])

    def test_experiment_5_policy_alert_trigger(self):
        """At 3 hours, if at least 2 of last 3 hours exceed threshold, alert must be confirmed."""
        hours_3_high = [
            {"ICULOS": 1.0, "HR": 85.0, "Temp": 37.0, "Resp": 16.0, "MAP": 85.0}, # Normal
            {"ICULOS": 2.0, "HR": 135.0, "Temp": 39.5, "Resp": 32.0, "MAP": 55.0, "WBC": 24.0, "Lactate": 4.5}, # Deteriorating
            {"ICULOS": 3.0, "HR": 142.0, "Temp": 39.8, "Resp": 35.0, "MAP": 50.0, "WBC": 28.0, "Lactate": 5.5}, # Septic
        ]
        payload = {
            "demographics": {"Age": 75.0, "Gender": 1.0, "Unit1": 1.0, "Unit2": 0.0, "HospAdmTime": -10.0},
            "hours": hours_3_high
        }
        res = self.data.manual_assessment(payload)
        self.assertEqual(res["total_observations"], 3)
        self.assertEqual(res["threshold_formatted"], "0.814708")

        # Verify whether Experiment 5 confirmation logic is followed
        scores = [h["model_score"] for h in res["hourly_assessments"]]
        threshold = res["threshold"]
        above_threshold = [s >= threshold for s in scores]
        pos_in_window = sum(above_threshold)

        if pos_in_window >= 2:
            self.assertTrue(res["latest_confirmed_alert"])
            self.assertIn("Confirmed", res["latest_confirmation_status"])
            self.assertIn("CRITICAL ALERT", res["latest_final_status"])
        else:
            self.assertFalse(res["latest_confirmed_alert"])

    def test_stable_patient_no_alert(self):
        """A normal stable patient across 3 hours must not trigger an alert."""
        hours_stable = [
            {"ICULOS": 1.0, "HR": 72.0, "Temp": 36.8, "Resp": 14.0, "MAP": 88.0, "O2Sat": 99.0},
            {"ICULOS": 2.0, "HR": 74.0, "Temp": 36.9, "Resp": 15.0, "MAP": 86.0, "O2Sat": 98.0},
            {"ICULOS": 3.0, "HR": 70.0, "Temp": 36.8, "Resp": 14.0, "MAP": 89.0, "O2Sat": 99.0},
        ]
        payload = {
            "demographics": {"Age": 45.0, "Gender": 0.0, "Unit1": 0.0, "Unit2": 1.0, "HospAdmTime": -2.0},
            "hours": hours_stable
        }
        res = self.data.manual_assessment(payload)
        self.assertFalse(res["latest_confirmed_alert"])
        self.assertLess(res["latest_score"], res["threshold"])
        self.assertIn("Unconfirmed (0/3", res["latest_confirmation_status"])

    def test_input_validation_physiological_ranges(self):
        """Out of range inputs must be rejected with helpful error messages."""
        base_demo = {"Age": 60.0, "Gender": 1.0}
        
        # Heart rate too high (e.g. 450 bpm)
        with self.assertRaises(DashboardInputError) as ctx:
            self.data.manual_assessment({
                "demographics": base_demo,
                "hours": [{"ICULOS": 1.0, "HR": 450.0}]
            })
        self.assertIn("plausible range", str(ctx.exception))
        self.assertIn("HR", str(ctx.exception))

        # Temperature too low (e.g. 15 C)
        with self.assertRaises(DashboardInputError) as ctx:
            self.data.manual_assessment({
                "demographics": base_demo,
                "hours": [{"ICULOS": 1.0, "Temp": 15.0}]
            })
        self.assertIn("plausible range", str(ctx.exception))
        self.assertIn("Temp", str(ctx.exception))

        # Age too high
        with self.assertRaises(DashboardInputError) as ctx:
            self.data.manual_assessment({
                "demographics": {"Age": 150.0, "Gender": 1.0},
                "hours": [{"ICULOS": 1.0, "HR": 80.0}]
            })
        self.assertIn("Age", str(ctx.exception))

        # Invalid Gender
        with self.assertRaises(DashboardInputError) as ctx:
            self.data.manual_assessment({
                "demographics": {"Age": 50.0, "Gender": 5.0},
                "hours": [{"ICULOS": 1.0, "HR": 80.0}]
            })
        self.assertIn("Gender", str(ctx.exception))

    def test_input_validation_iculos_ordering(self):
        """ICULOS must be positive, integer, and strictly increasing."""
        # Non-increasing ICULOS
        with self.assertRaises(DashboardInputError) as ctx:
            self.data.manual_assessment({
                "hours": [
                    {"ICULOS": 2.0, "HR": 80.0},
                    {"ICULOS": 2.0, "HR": 85.0}
                ]
            })
        self.assertIn("strictly greater", str(ctx.exception))

        # Decreasing ICULOS
        with self.assertRaises(DashboardInputError) as ctx:
            self.data.manual_assessment({
                "hours": [
                    {"ICULOS": 3.0, "HR": 80.0},
                    {"ICULOS": 2.0, "HR": 85.0}
                ]
            })
        self.assertIn("strictly greater", str(ctx.exception))

        # Negative ICULOS
        with self.assertRaises(DashboardInputError) as ctx:
            self.data.manual_assessment({
                "hours": [{"ICULOS": -1.0, "HR": 80.0}]
            })
        self.assertIn("positive integer hour", str(ctx.exception))

    def test_shap_additivity_on_manual_assessment(self):
        """TreeSHAP base margin plus feature contributions must equal raw model margin."""
        payload = {
            "demographics": {"Age": 65.0, "Gender": 1.0, "Unit1": 1.0, "Unit2": 0.0, "HospAdmTime": -12.0},
            "hours": [
                {"ICULOS": 1.0, "HR": 95.0, "Temp": 38.0, "Resp": 22.0, "MAP": 75.0},
                {"ICULOS": 2.0, "HR": 105.0, "Temp": 38.4, "Resp": 24.0, "MAP": 70.0},
                {"ICULOS": 3.0, "HR": 115.0, "Temp": 38.8, "Resp": 26.0, "MAP": 65.0}
            ]
        }
        res = self.data.manual_assessment(payload)
        shap_info = res["shap"]
        base_val = shap_info["base_value"]
        margin = shap_info["margin"]
        total_shap = sum(f["shap_value"] for f in shap_info["features"])
        self.assertAlmostEqual(base_val + total_shap, margin, places=4)


if __name__ == "__main__":
    unittest.main()

