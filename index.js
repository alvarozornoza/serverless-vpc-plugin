const AWS = require('aws-sdk');
const CIDR = require('cidr-split');
const merge = require('lodash.merge');

class ServerlessVpcPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options || {};

    this.provider = this.serverless.getProvider('aws');

    this.hooks = {
      'after:package:initialize': this.afterInitialize.bind(this),
    };
  }

  async afterInitialize() {
    let cidrBlock = '10.0.0.0/16';
    let useNatGateway = false;

    const { vpcConfig } = this.serverless.service.custom;

    if (vpcConfig) {
      if (vpcConfig.cidrBlock && typeof vpcConfig.cidrBlock === 'string') {
        ({ cidrBlock } = vpcConfig);
      }
      if ('useNatGateway' in vpcConfig && typeof vpcConfig.useNatGateway === 'boolean') {
        ({ useNatGateway } = vpcConfig);
      }
    }

    const region = this.provider.getRegion();

    const zones = await this.getZonesPerRegion(region);
    const numZones = zones.length;

    this.serverless.cli.log(`Generating a VPC in ${region} (${cidrBlock}) across ${numZones} availability zones`);

    merge(
      this.serverless.service.provider.compiledCloudFormationTemplate.Resources,
      this.buildVpc({ cidrBlock }),
      this.buildInternetGateway(),
      ServerlessVpcPlugin.buildInternetGatewayAttachment(),
      this.buildAvailabilityZones({ cidrBlock, zones, useNatGateway }),
      ServerlessVpcPlugin.buildRDSSubnetGroup({ numZones }),
      ServerlessVpcPlugin.buildElastiCacheSubnetGroup({ numZones }),
      ServerlessVpcPlugin.buildRedshiftSubnetGroup({ numZones }),
      ServerlessVpcPlugin.buildS3Endpoint({ numZones }),
      ServerlessVpcPlugin.buildDynamoDBEndpoint({ numZones }),
      this.buildLambdaSecurityGroup(),
    );
  }

  /**
   * Return an array of availability zones for a given region.
   *
   * @param {String} region
   * @return {Array}
   */
  async getZonesPerRegion(region) {
    const awsCreds = this.serverless.providers.aws.getCredentials();

    AWS.config.update(awsCreds);
    this.ec2 = new AWS.EC2({ region });

    const params = {
      Filters: [
        {
          Name: 'region-name',
          Values: [region],
        },
      ],
    };
    return this.ec2.describeAvailabilityZones(params).promise().then(
      data => data.AvailabilityZones
        .filter(z => z.State === 'available')
        .map(z => z.ZoneName)
        .sort(),
    );
  }

  /**
   * Build a VPC
   *
   * @param {Object} params
   * @return {Object}
   */
  buildVpc({ name = 'VPC', cidrBlock = '10.0.0.0/16' } = {}) {
    return {
      [name]: {
        Type: 'AWS::EC2::VPC',
        Properties: {
          CidrBlock: cidrBlock,
          EnableDnsSupport: true,
          EnableDnsHostnames: true,
          InstanceTenancy: 'default',
          Tags: [
            {
              Key: 'STAGE',
              Value: this.provider.getStage(),
            },
            {
              Key: 'Name',
              Value: {
                Ref: 'AWS::StackName',
              },
            },
          ],
        },
      },
    };
  }

  /**
   * Build an InternetGateway
   *
   * @param {Object} params
   * @return {Object}
   */
  buildInternetGateway({ name = 'InternetGateway' } = {}) {
    return {
      [name]: {
        Type: 'AWS::EC2::InternetGateway',
        Properties: {
          Tags: [
            {
              Key: 'STAGE',
              Value: this.provider.getStage(),
            },
            {
              Key: 'Name',
              Value: {
                Ref: 'AWS::StackName',
              },
            },
          ],
        },
      },
    };
  }

  /**
   * Build an InternetGatewayAttachment
   *
   * @param {Object} params
   * @return {Object}
   */
  static buildInternetGatewayAttachment({ name = 'InternetGatewayAttachment' } = {}) {
    return {
      [name]: {
        Type: 'AWS::EC2::VPCGatewayAttachment',
        Properties: {
          InternetGatewayId: {
            Ref: 'InternetGateway',
          },
          VpcId: {
            Ref: 'VPC',
          },
        },
      },
    };
  }

  /**
   * Split a /16 CIDR block into /20 CIDR blocks.
   *
   * @param {String} cidrBlock
   * @return {Array}
   */
  static splitVpc(cidrBlock) {
    return CIDR.fromString(cidrBlock)
      .split()
      .map(cidr => cidr.split())
      .reduce((all, halves) => all.concat(...halves))
      .map(cidr => cidr.split())
      .reduce((all, halves) => all.concat(...halves))
      .map(cidr => cidr.split())
      .reduce((all, halves) => all.concat(...halves));
  }

  /**
   * Builds the Availability Zones for the region.
   *
   * 1.) Splits the VPC CIDR Block into /20 subnets, one per AZ.
   * 2.) Split each AZ /20 CIDR Block into two /21 subnets
   * 3.) Use the first /21 subnet for Applications
   * 3.) Split the second /21 subnet into two /22 subnets: one Public subnet (for load balancers),
   *     and one for databases (RDS, ElastiCache, and Redshift)
   *
   * @param {String} cidrBlock VPC CIDR Block
   * @param {Array} zones Array of availability zones
   * @param {Boolean} useNatGateway Whether to create NAT Gateways or not
   * @return {Object}
   */
  buildAvailabilityZones({ cidrBlock, zones, useNatGateway = true } = {}) {
    const azCidrBlocks = ServerlessVpcPlugin.splitVpc(cidrBlock); // VPC subnet is a /16
    const resources = {};

    zones.forEach((zone, index) => {
      const azCidrBlock = azCidrBlocks[index]; // AZ subnet is a /20
      const position = index + 1;

      let subnets = [];

      const azSubnets = CIDR.fromString(azCidrBlock).split().map(cidr => cidr.toString());
      subnets.push(azSubnets[0]); // Application subnet is a /21

      const publicSubnets = CIDR.fromString(azSubnets[1]).split().map(cidr => cidr.toString());
      subnets = subnets.concat(publicSubnets); // Public and DB subnets are both /22

      if (useNatGateway) {
        merge(resources, ServerlessVpcPlugin.buildEIP(position));
        merge(resources, this.buildNatGateway(position, zone));
      }

      merge(resources, this.buildSubnet('App', position, zone, subnets[0]));
      merge(resources, this.buildRouteTable('App', position, zone));
      merge(resources, ServerlessVpcPlugin.buildRouteTableAssociation('App', position));

      const params = {
        name: 'App',
        position,
      };

      if (useNatGateway) {
        params.NatGatewayId = `NatGateway${position}`;
      } else {
        params.GatewayId = 'InternetGateway';
      }

      merge(resources, ServerlessVpcPlugin.buildRoute(params));

      merge(resources, this.buildSubnet('Public', position, zone, subnets[1]));
      merge(resources, this.buildRouteTable('Public', position, zone));
      merge(resources, ServerlessVpcPlugin.buildRouteTableAssociation('Public', position));
      merge(resources, ServerlessVpcPlugin.buildRoute({
        name: 'Public',
        position,
        GatewayId: 'InternetGateway',
      }));

      merge(resources, this.buildSubnet('DB', position, zone, subnets[2]));
      merge(resources, this.buildRouteTable('DB', position, zone));
      merge(resources, ServerlessVpcPlugin.buildRouteTableAssociation('DB', position));
    });

    return resources;
  }

  /**
   * Create a subnet
   *
   * @param {String} name
   * @param {Number} position
   * @param {String} zone
   * @param {String} cidrBlock
   * @return {Object}
   */
  buildSubnet(name, position, zone, cidrBlock) {
    const cfName = `${name}Subnet${position}`;
    return {
      [cfName]: {
        Type: 'AWS::EC2::Subnet',
        Properties: {
          AvailabilityZone: zone,
          CidrBlock: cidrBlock,
          Tags: [
            {
              Key: 'STAGE',
              Value: this.provider.getStage(),
            },
            {
              Key: 'Name',
              Value: {
                'Fn::Join': [
                  '-',
                  [
                    {
                      Ref: 'AWS::StackName',
                    },
                    name.toLowerCase(),
                    zone,
                  ],
                ],
              },
            },
          ],
          VpcId: {
            Ref: 'VPC',
          },
        },
      },
    };
  }

  /**
   * Build an EIP
   *
   * @param {Number} position
   * @return {Object}
   */
  static buildEIP(position) {
    const cfName = `EIP${position}`;
    return {
      [cfName]: {
        Type: 'AWS::EC2::EIP',
        Properties: {
          Domain: 'vpc',
        },
      },
    };
  }

  /**
   * Build a NatGateway in a given AZ
   *
   * @param {Number} position
   * @param {String} zone
   * @return {Object}
   */
  buildNatGateway(position, zone) {
    const cfName = `NatGateway${position}`;

    return {
      [cfName]: {
        Type: 'AWS::EC2::NatGateway',
        Properties: {
          AllocationId: {
            'Fn::GetAtt': [
              `EIP${position}`,
              'AllocationId',
            ],
          },
          SubnetId: {
            Ref: `PublicSubnet${position}`,
          },
          Tags: [
            {
              Key: 'STAGE',
              Value: this.provider.getStage(),
            },
            {
              Key: 'Name',
              Value: {
                'Fn::Join': [
                  '-',
                  [
                    {
                      Ref: 'AWS::StackName',
                    },
                    zone,
                  ],
                ],
              },
            },
          ],
        },
      },
    };
  }

  /**
   * Build a RouteTable in a given AZ
   *
   * @param {String} name
   * @param {Number} position
   * @param {String} zone
   * @return {Object}
   */
  buildRouteTable(name, position, zone) {
    const cfName = `${name}RouteTable${position}`;
    return {
      [cfName]: {
        Type: 'AWS::EC2::RouteTable',
        Properties: {
          VpcId: {
            Ref: 'VPC',
          },
          Tags: [
            {
              Key: 'STAGE',
              Value: this.provider.getStage(),
            },
            {
              Key: 'Name',
              Value: {
                'Fn::Join': [
                  '-',
                  [
                    {
                      Ref: 'AWS::StackName',
                    },
                    name.toLowerCase(),
                    zone,
                  ],
                ],
              },
            },
          ],
        },
      },
    };
  }

  /**
   * Build a RouteTableAssociation
   *
   * @param {String} name
   * @param {Number} position
   * @return {Object}
   */
  static buildRouteTableAssociation(name, position) {
    const cfName = `${name}RouteTableAssociation${position}`;

    return {
      [cfName]: {
        Type: 'AWS::EC2::SubnetRouteTableAssociation',
        Properties: {
          RouteTableId: {
            Ref: `${name}RouteTable${position}`,
          },
          SubnetId: {
            Ref: `${name}Subnet${position}`,
          },
        },
      },
    };
  }

  /**
   * Build a Route for a NatGateway or InternetGateway
   *
   * @param {Object} params
   * @return {Object}
   */
  static buildRoute({
    name, position, NatGatewayId = null, GatewayId = null,
  } = {}) {
    const cfName = `${name}Route${position}`;

    const route = {
      [cfName]: {
        Type: 'AWS::EC2::Route',
        Properties: {
          DestinationCidrBlock: '0.0.0.0/0',
          RouteTableId: {
            Ref: `${name}RouteTable${position}`,
          },
        },
      },
    };

    if (NatGatewayId) {
      route[cfName].Properties.NatGatewayId = {
        Ref: NatGatewayId,
      };
    } else if (GatewayId) {
      route[cfName].Properties.GatewayId = {
        Ref: GatewayId,
      };
    }

    return route;
  }

  /**
   * Build an RDSubnetGroup for a given number of zones
   *
   * @param {Objects} params
   * @return {Object}
   */
  static buildRDSSubnetGroup({ name = 'RDSSubnetGroup', numZones } = {}) {
    const subnetIds = [];
    for (let i = 1; i <= numZones; i += 1) {
      subnetIds.push({ Ref: `DBSubnet${i}` });
    }

    return {
      [name]: {
        Type: 'AWS::RDS::DBSubnetGroup',
        Properties: {
          DBSubnetGroupDescription: {
            Ref: 'AWS::StackName',
          },
          SubnetIds: subnetIds,
        },
      },
    };
  }

  /**
   * Build an ElastiCacheSubnetGroup for a given number of zones
   *
   * @param {Object} params
   * @return {Object}
   */
  static buildElastiCacheSubnetGroup({ name = 'ElastiCacheSubnetGroup', numZones } = {}) {
    const subnetIds = [];
    for (let i = 1; i <= numZones; i += 1) {
      subnetIds.push({ Ref: `DBSubnet${i}` });
    }

    return {
      [name]: {
        Type: 'AWS::ElastiCache::SubnetGroup',
        Properties: {
          Description: {
            Ref: 'AWS::StackName',
          },
          SubnetIds: subnetIds,
        },
      },
    };
  }

  /**
   * Build an RedshiftSubnetGroup for a given number of zones
   *
   * @param {Object} params
   * @return {Object}
   */
  static buildRedshiftSubnetGroup({ name = 'RedshiftSubnetGroup', numZones } = {}) {
    const subnetIds = [];
    for (let i = 1; i <= numZones; i += 1) {
      subnetIds.push({ Ref: `DBSubnet${i}` });
    }

    return {
      [name]: {
        Type: 'AWS::Redshift::ClusterSubnetGroup',
        Properties: {
          Description: {
            Ref: 'AWS::StackName',
          },
          SubnetIds: subnetIds,
        },
      },
    };
  }

  /**
   * Build an S3Endpoint for a given number of zones
   *
   * @param {Object} params
   * @return {Object}
   */
  static buildS3Endpoint({ name = 'S3Endpoint', numZones } = {}) {
    const routeTableIds = [];
    for (let i = 1; i <= numZones; i += 1) {
      routeTableIds.push({ Ref: `AppRouteTable${i}` });
    }

    return {
      [name]: {
        Type: 'AWS::EC2::VPCEndpoint',
        Properties: {
          RouteTableIds: routeTableIds,
          ServiceName: {
            'Fn::Join': [
              '.',
              [
                'com.amazonaws',
                {
                  Ref: 'AWS::Region',
                },
                's3',
              ],
            ],
          },
          VpcId: {
            Ref: 'VPC',
          },
        },
      },
    };
  }

  /**
   * Build a DynamoDBEndpoint for a given number of zones
   *
   * @param {Object} params
   * @return {Object}
   */
  static buildDynamoDBEndpoint({ name = 'DynamoDBEndpoint', numZones } = {}) {
    const routeTableIds = [];
    for (let i = 1; i <= numZones; i += 1) {
      routeTableIds.push({ Ref: `AppRouteTable${i}` });
    }

    return {
      [name]: {
        Type: 'AWS::EC2::VPCEndpoint',
        Properties: {
          RouteTableIds: routeTableIds,
          ServiceName: {
            'Fn::Join': [
              '.',
              [
                'com.amazonaws',
                {
                  Ref: 'AWS::Region',
                },
                'dynamodb',
              ],
            ],
          },
          VpcId: {
            Ref: 'VPC',
          },
        },
      },
    };
  }

  /**
   * Build a SecurityGroup to be used by Lambda's when they execute.
   *
   * @param {Object} params
   * @return {Object}
   */
  buildLambdaSecurityGroup({ name = 'LambdaExecutionSecurityGroup' } = {}) {
    return {
      [name]: {
        Type: 'AWS::EC2::SecurityGroup',
        Properties: {
          GroupDescription: 'Lambda Execution Group',
          VpcId: {
            Ref: 'VPC',
          },
          Tags: [
            {
              Key: 'STAGE',
              Value: this.provider.getStage(),
            },
            {
              Key: 'Name',
              Value: {
                'Fn::Join': [
                  '-',
                  [
                    {
                      Ref: 'AWS::StackName',
                    },
                    'lambda-exec',
                  ],
                ],
              },
            },
          ],
        },
      },
    };
  }
}

module.exports = ServerlessVpcPlugin;