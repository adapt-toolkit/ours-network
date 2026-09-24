# language: en
@regression @fleet-pair
Feature: Fleet room provisioning regressions

  Scenario Outline: Fleet launches two task agents into one Cowork room
    Given Fleet uses a deterministic ACP agent and Cowork on server <host> with room template "pair":
      | slot      | role      |
      | developer | Developer |
      | critic    | Critic    |
    When Fleet starts a task using the "pair" room template
    Then every configured Fleet member has an active Cowork room seat
    And each room seat belongs to a live Fleet agent

    @host-a
    Examples: Fleet hosted on A
      | host |
      | A    |

    @host-b
    Examples: Fleet hosted on B
      | host |
      | B    |

  @fleet-team
  Scenario Outline: Fleet launches a three-member team
    Given Fleet uses a deterministic ACP agent and Cowork on server <host> with room template "team":
      | slot      | role      |
      | developer | Developer |
      | critic    | Critic    |
      | tester    | Tester    |
    When Fleet starts a task using the "team" room template
    Then every configured Fleet member has an active Cowork room seat
    And each room seat belongs to a live Fleet agent

    Examples: Team hosts
      | host |
      | A    |
      | B    |
