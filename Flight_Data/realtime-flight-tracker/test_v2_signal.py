import unittest

from v2_signal import (
    BuildingFeature,
    LGA_LAT,
    LGA_LON,
    SignalV2Engine,
    StaticBuildingProvider,
    evaluate_buildings,
    interpolate_observations,
    knife_edge_loss,
    predict_observation,
)


def observation(timestamp: float, longitude: float, altitude_m: float = 600.0) -> dict:
    return {
        "timestamp": timestamp,
        "latitude": LGA_LAT,
        "longitude": longitude,
        "geo_altitude_m": altitude_m,
        "baro_altitude_m": altitude_m,
        "altitude_m": altitude_m,
        "altitude_ft": altitude_m * 3.28084,
        "speed_kt": 120.0,
        "heading_deg": 270.0,
        "vertical_fpm": -500.0,
        "distance_nm": abs(longitude - LGA_LON) * 45.5,
        "on_ground": False,
    }


class PositionModelTests(unittest.TestCase):
    def test_interpolation_preserves_endpoints_and_midpoint(self) -> None:
        start = observation(1000.0, LGA_LON + 0.04, 900.0)
        end = observation(1030.0, LGA_LON + 0.02, 600.0)
        start["speed_kt"] = end["speed_kt"] = None
        start["vertical_fpm"] = end["vertical_fpm"] = None

        midpoint = interpolate_observations(start, end, 1015.0)

        self.assertAlmostEqual(midpoint["longitude"], LGA_LON + 0.03, places=6)
        self.assertAlmostEqual(midpoint["geo_altitude_m"], 750.0, places=6)
        self.assertEqual(midpoint["timestamp"], 1015.0)

    def test_prediction_advances_one_second_at_a_time(self) -> None:
        point = observation(1000.0, LGA_LON + 0.03)
        predicted = predict_observation([point], 10)

        self.assertEqual(predicted["timestamp"], 1010.0)
        self.assertLess(predicted["longitude"], point["longitude"])
        self.assertLess(predicted["geo_altitude_m"], point["geo_altitude_m"])


class BuildingLossTests(unittest.TestCase):
    def setUp(self) -> None:
        center_lon = LGA_LON + 0.005
        self.building = BuildingFeature(
            building_id="test-building",
            rings=[[
                (center_lon - 0.0002, LGA_LAT - 0.0002),
                (center_lon + 0.0002, LGA_LAT - 0.0002),
                (center_lon + 0.0002, LGA_LAT + 0.0002),
                (center_lon - 0.0002, LGA_LAT + 0.0002),
                (center_lon - 0.0002, LGA_LAT - 0.0002),
            ]],
            height_m=100.0,
            min_height_m=0.0,
            height_status="estimated_default_10m",
        )

    def test_knife_edge_threshold(self) -> None:
        self.assertEqual(knife_edge_loss(-0.7), 0.0)
        self.assertGreater(knife_edge_loss(0.0), 0.0)

    def test_dominant_building_adds_loss_without_style_metadata(self) -> None:
        blocked = evaluate_buildings(
            LGA_LAT,
            LGA_LON,
            50.0,
            LGA_LAT,
            LGA_LON + 0.01,
            60.0,
            118.7,
            [self.building],
        )

        self.assertTrue(blocked["building_blocked"])
        self.assertGreater(blocked["building_loss_db"], 0.0)
        self.assertEqual(blocked["building_height_status"], "estimated_default_10m")
        self.assertNotIn("style", blocked)

    def test_high_aircraft_has_no_diffraction_loss(self) -> None:
        clear = StaticBuildingProvider([self.building]).obstruction(
            LGA_LAT,
            LGA_LON,
            50.0,
            LGA_LAT,
            LGA_LON + 0.01,
            2000.0,
            118.7,
        )

        self.assertFalse(clear["building_blocked"])
        self.assertEqual(clear["building_loss_db"], 0.0)


class SignalEngineTests(unittest.TestCase):
    def test_actual_endpoint_reconciles_prior_prediction_interval(self) -> None:
        engine = SignalV2Engine()
        start = observation(1000.0, LGA_LON + 0.04, 900.0)
        end = observation(1030.0, LGA_LON + 0.02, 600.0)

        engine.ingest_actual("abc123", start, "arrival", "probable")
        first_snapshot = engine.snapshot("abc123", 1005.0)
        self.assertIsNotNone(first_snapshot)
        self.assertEqual(len(first_snapshot["predicted_timeline"]), 30)

        engine.ingest_actual("abc123", end, "arrival", "confirmed")
        history = engine.history("abc123")

        self.assertEqual(len(history["points"]), 31)
        self.assertEqual(history["points"][0]["timestamp"], 1000.0)
        self.assertEqual(history["points"][-1]["timestamp"], 1030.0)
        self.assertTrue(history["points"][1]["was_live_prediction"])
        frequencies = {
            point["most_likely_frequency_mhz"]
            for point in history["points"]
            if point["most_likely_frequency_mhz"] is not None
        }
        self.assertEqual(frequencies, {118.7})
        self.assertTrue(all(point["total_loss_db"] is not None for point in history["points"]))

    def test_since_returns_only_new_finalized_points(self) -> None:
        engine = SignalV2Engine()
        engine.ingest_actual("abc123", observation(1000.0, LGA_LON + 0.04), "arrival", "probable")
        engine.ingest_actual("abc123", observation(1030.0, LGA_LON + 0.02), "arrival", "confirmed")

        history = engine.history("abc123", since=1028.0)

        self.assertEqual([point["timestamp"] for point in history["points"]], [1029.0, 1030.0])


if __name__ == "__main__":
    unittest.main()
