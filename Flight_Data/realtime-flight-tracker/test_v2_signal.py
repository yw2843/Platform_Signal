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
    def test_building_obstruction_runs_only_for_actual_observations(self) -> None:
        class CountingBuildingProvider:
            source_name = "counting_test"

            def __init__(self) -> None:
                self.calls = 0

            def obstruction(self, *args: float) -> dict:
                self.calls += 1
                return {
                    "building_data_status": "available",
                    "building_blocked": False,
                    "blocking_building_count": 0,
                    "dominant_building_id": None,
                    "dominant_building_height_m": None,
                    "building_height_status": None,
                    "worst_clearance_m": None,
                    "fresnel_radius_m": None,
                    "diffraction_v": None,
                    "building_loss_db": 0.0,
                }

        provider = CountingBuildingProvider()
        engine = SignalV2Engine(provider)
        engine.ingest_actual(
            "abc123",
            observation(1000.0, LGA_LON + 0.04, 900.0),
            "arrival",
            "probable",
        )
        engine.ingest_actual(
            "abc123",
            observation(1030.0, LGA_LON + 0.02, 600.0),
            "arrival",
            "confirmed",
        )

        snapshot = engine.snapshot("abc123", 1030.0)
        self.assertEqual(provider.calls, 2)
        self.assertEqual(snapshot["current"]["building_calculation_status"], "observed_exact")
        self.assertEqual(snapshot["current"]["heading_deg"], 270.0)
        self.assertEqual(snapshot["current"]["speed_kt"], 120.0)
        self.assertEqual(snapshot["current"]["vertical_fpm"], -500.0)
        self.assertTrue(
            all(
                point["building_calculation_status"] == "held_from_latest_observation"
                for point in snapshot["predicted_timeline"]
            )
        )

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

    def test_frequency_is_held_once_then_cleared_after_two_unmatched_actuals(self) -> None:
        engine = SignalV2Engine()
        engine.ingest_actual(
            "abc123",
            observation(1000.0, LGA_LON + 0.03),
            "arrival",
            "probable",
        )
        first_unmatched = observation(1030.0, LGA_LON + 0.03)
        first_unmatched["vertical_fpm"] = 0.0
        engine.ingest_actual("abc123", first_unmatched, "arrival", "confirmed")

        held = engine.snapshot("abc123", 1030.0)["current"]
        self.assertEqual(held["frequency_assignment_status"], "held_during_transition")
        self.assertEqual(held["most_likely_frequency_mhz"], 118.7)
        self.assertIsNotNone(held["total_loss_db"])

        second_unmatched = observation(1060.0, LGA_LON + 0.03)
        second_unmatched["vertical_fpm"] = 0.0
        engine.ingest_actual("abc123", second_unmatched, "arrival", "confirmed")

        cleared = engine.snapshot("abc123", 1060.0)["current"]
        self.assertEqual(cleared["frequency_assignment_status"], "unavailable")
        self.assertIsNone(cleared["most_likely_frequency_mhz"])
        self.assertIsNone(cleared["total_loss_db"])


if __name__ == "__main__":
    unittest.main()
