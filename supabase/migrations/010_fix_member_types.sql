-- =====================================================
-- Fix member types based on pin slot assignment
--
-- Members with a permanent pin slot (1-100) are coworking
-- members (cold_desk or hot_desk), never day_pass.
-- This corrects any misclassification from the initial
-- member import or manual data entry errors.
-- =====================================================

-- If a member has a permanent PIN slot, they should be cold_desk (not day_pass).
-- We default to cold_desk; admins can manually upgrade to hot_desk as needed.
update members
set member_type = 'cold_desk'
where member_type = 'day_pass'
  and pin_code_slot is not null
  and pin_code_slot between 1 and 100;
