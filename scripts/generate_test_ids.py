import pandas as pd, gzip, csv, os
pred_path = r'd:\Downloads\MajorProjectCopy\MajorProjectCopy\reports\models\xgboost\test_predictions.csv.gz'
with gzip.open(pred_path, 'rt') as f:
    df = pd.read_csv(f)
# Determine patient-level sepsis label: any row with SepsisLabel==1 marks patient as sepsis
patient_sepsis = df.groupby('patient_id')['SepsisLabel'].max()
sepsis_ids = patient_sepsis[patient_sepsis == 1].index.tolist()
nonsepsis_ids = patient_sepsis[patient_sepsis == 0].index.tolist()
out_dir = os.path.dirname(pred_path)  # same folder as predictions
# Write sepsis IDs CSV
with open(os.path.join(out_dir, 'test_sepsis_ids.csv'), 'w', newline='') as f:
    writer = csv.writer(f)
    writer.writerow(['patient_id'])
    for pid in sepsis_ids:
        writer.writerow([pid])
# Write non‑sepsis IDs CSV
with open(os.path.join(out_dir, 'test_nonsepsis_ids.csv'), 'w', newline='') as f:
    writer = csv.writer(f)
    writer.writerow(['patient_id'])
    for pid in nonsepsis_ids:
        writer.writerow([pid])
print('Sepsis patients:', len(sepsis_ids))
print('Non‑sepsis patients:', len(nonsepsis_ids))

